import type { FlatSettings } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { challenges, type spawnQueue } from "../db/schema"
import type { Clock, ClockTimer } from "./clock"
import { createTimerHub, systemClock } from "./clock"
import { RunActionError } from "./errors"
import { checkSpawnFence, type FenceDecision } from "./fence"

type QueueRow = typeof spawnQueue.$inferSelect

const DRAIN_DEBOUNCE_MS = 200

/** Fallback wake-up after a `global_capacity` stop: nothing else triggers a
 * drain when a slot frees, so the drainer re-arms itself at a bounded pace
 * instead of sleeping until an external event. */
const CAPACITY_RETRY_MS = 5_000

/** What the drainer does with one pending item given the fence's admission
 * decision — the entire machine-side scheduling policy, as a pure function. */
export type DrainAction =
  | { kind: "launch" }
  | { kind: "skip" }
  | { kind: "cancel" }
  | { kind: "stop" }

export function planDrainStep(decision: FenceDecision): DrainAction {
  if (decision.ok) return { kind: "launch" }
  switch (decision.code) {
    // Global cap is saturated: no later item can launch either — stop the
    // pass (items stay pending).
    case "global_capacity":
      return { kind: "stop" }
    // Stale work for a solved challenge: drop it, try the rest.
    case "challenge_solved":
      return { kind: "cancel" }
    // Per-event target cap: only this item is blocked; try the rest. An
    // unknown future code degrades to the same skip-and-continue.
    case "target_slots":
    default:
      return { kind: "skip" }
  }
}

/** The queue-side persistence the drainer drives (the write half of the
 * queue store; reads go through pendingItems). */
type QueueDrainerStore = {
  pendingItems(): QueueRow[]
  /** Guarded pending→running flip; false = the item was no longer pending
   * (cancelled/removed mid-launch), so the launched agent is superseded. */
  markRunning(itemId: string, agentId: string): boolean
  markFailed(itemId: string, error: string): void
  markCancelled(itemId: string): void
}

export type QueueDrainerDeps = {
  db: Database
  getSettings(): FlatSettings
  /** Whether the owning service has been closed (drain becomes a no-op). */
  isDisposed(): boolean
  /** Spawn one agent for a queued item and return its id. Resolves only on
   * success; rejects with {@link RunActionError} (capacity /
   * launch_failed) or other errors. */
  launch(item: QueueRow): Promise<string>
  /** Emergency info for the event's scheduler DM: a permanent launch
   * failure. Posted as an urgent system message (immediate flush). Never
   * throws. */
  onEmergency(eventId: string, failure: LaunchFailureInfo): void
  /** Settle a just-spawned agent whose queue item was cancelled/removed
   * mid-launch (markRunning lost the race): the agent must not stay live on
   * work nobody owns anymore. Fire-and-forget — the drainer never awaits or
   * propagates its failure. */
  onSupersededLaunch?: (agentId: string) => void | Promise<void>
  store: QueueDrainerStore
  /** Capacity-retry delay (test seam; default {@link CAPACITY_RETRY_MS}). */
  retryMs?: number
  /** Time layer (default: the system clock); schedules the debounce and the
   * capacity retry. */
  clock?: Clock
}

/** Structured launch-failure facts for the notice event: the wording lives
 * in the notice template, the drainer only resolves the challenge name and
 * bounds the error text. */
export type LaunchFailureInfo = { challengeName: string; error: string }

function launchFailureInfo(
  db: Database,
  item: QueueRow,
  error: string
): LaunchFailureInfo {
  const name =
    db
      .select({ name: challenges.name })
      .from(challenges)
      .where(eq(challenges.id, item.challengeId))
      .get()?.name ?? item.challengeId
  return {
    challengeName: name,
    error: error.length > 200 ? `${error.slice(0, 200)}…` : error,
  }
}

function isCapacity(error: unknown): boolean {
  return error instanceof RunActionError && error.code === "capacity"
}

export function createQueueDrainer(deps: QueueDrainerDeps) {
  const retryMs = deps.retryMs ?? CAPACITY_RETRY_MS
  const hub = createTimerHub(deps.clock ?? systemClock)

  let drainTimer: ClockTimer | null = null
  let draining = false
  let drainRequested = false
  let capacityRetry: ClockTimer | null = null

  function runPass(): void {
    void drainOnce().catch((error) => {
      console.error("spawn queue drain failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Re-arm the bounded capacity retry (at most one pending). */
  function armCapacityRetry(): void {
    if (capacityRetry || deps.isDisposed()) return
    capacityRetry = hub.setTimeout(() => {
      capacityRetry = null
      runPass()
    }, retryMs)
  }

  /** Debounced drain: collapses a burst of triggers (enqueue / agent
   * terminal / boot) into one pass. A trigger arriving mid-pass only sets
   * {@link drainRequested}; the running pass re-arms the debounce when it
   * finishes so the trigger is not lost. An external trigger supersedes any
   * pending capacity retry — the pass it opens covers the same need. */
  function scheduleDrain(): void {
    if (capacityRetry) {
      hub.clear(capacityRetry)
      capacityRetry = null
    }
    if (draining) {
      drainRequested = true
      return
    }
    if (drainTimer) return
    drainTimer = hub.setTimeout(() => {
      drainTimer = null
      runPass()
    }, DRAIN_DEBOUNCE_MS)
  }

  /**
   * One drain pass over pending items in FIFO order. Each item's fate is
   * {@link planDrainStep} over the fence decision; a launch failure marks
   * the item failed + notifies, a (racy) capacity reject stays pending.
   * Single-flight: a trigger arriving mid-pass is recorded via
   * scheduleDrain → drainRequested; the finished pass re-arms the debounce
   * so the trailing trigger opens a fresh pass instead of being dropped.
   */
  async function drainOnce(): Promise<void> {
    if (draining || deps.isDisposed()) return
    draining = true
    try {
      for (const item of deps.store.pendingItems()) {
        const decision = checkSpawnFence(deps.db, deps.getSettings(), {
          eventId: item.eventId,
          challengeId: item.challengeId,
        })
        const action = planDrainStep(decision)
        if (action.kind === "stop") {
          armCapacityRetry()
          return
        }
        if (action.kind === "cancel") {
          deps.store.markCancelled(item.id)
          continue
        }
        if (action.kind === "skip") continue
        try {
          const agentId = await deps.launch(item)
          if (deps.store.markRunning(item.id, agentId)) continue
          // Lost race: the item was cancelled (e.g. full-solve cleanup) or
          // removed while the launch ran. The agent just spawned live on
          // abandoned work — settle it instead of letting it attack a solved
          // challenge until its deadline. Fire-and-forget: a settle failure
          // must not abort the pass or throw out of drainOnce.
          void Promise.resolve(deps.onSupersededLaunch?.(agentId)).catch(
            (error) => {
              console.error("superseded launch settle failed", {
                agentId,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          )
        } catch (error) {
          if (isCapacity(error)) continue // race with another spawn; stay pending
          const message = error instanceof Error ? error.message : String(error)
          deps.store.markFailed(item.id, message)
          deps.onEmergency(
            item.eventId,
            launchFailureInfo(deps.db, item, message)
          )
        }
      }
    } finally {
      draining = false
      const rerun = drainRequested
      drainRequested = false
      if (rerun && !deps.isDisposed()) scheduleDrain()
    }
  }

  /** Cancel any pending debounced drain or capacity retry (called from the
   * service close so no timer fires against a disposed service/db). */
  function cancelDrain(): void {
    drainRequested = false
    hub.disposeAll()
    drainTimer = null
    capacityRetry = null
  }

  return { scheduleDrain, drainOnce, cancelDrain }
}
