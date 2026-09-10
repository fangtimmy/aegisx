import { LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents, queueState, spawnQueue } from "../db/schema"
import type { Clock, ClockTimer } from "./clock"
import { createTimerHub, systemClock } from "./clock"

/** Alert cadence for the fleet health check. */
export const FLEET_WATCHDOG_INTERVAL_MS = 2 * 60_000

/** How long an event may sit with pending work and no solver making progress
 * before it is declared stalled. Must exceed the drainer's capacity retry and
 * launch latencies (a slow container build is not a stall). */
export const FLEET_STALL_MS = 10 * 60_000

/** The structural facts of one stalled event. */
export type FleetStall = {
  eventId: string
  /** Pending spawn_queue items that no one is draining. */
  pending: number
  /** How long the drain has made no progress (no launch, no queue change). */
  stalledMs: number
}

type FleetWatchdogDeps = {
  db: Database
  /** Publish the urgent orch notice (the service wires notices.publish). */
  onStalled(event: FleetStall): void
  /** A disabled scheduler cannot act on the notice — skip it silently. */
  isSchedulerPaused(eventId: string): boolean
  /** Time layer (default: system clock); tests inject a fake clock. */
  clock?: Clock
  intervalMs?: number
  stallMs?: number
}

/** Per-event drain-progress memory. `marker` fingerprints the pending set;
 * `progressAt` is when it last changed (or when the stalled condition was
 * first observed) — the clock the stall window is measured against. `fired`
 * makes an episode alert at most once. */
type ProgressState = { marker: string; progressAt: number; fired: boolean }

/**
 * Event-level vital-signs watchdog. The per-agent stall watchdog only covers
 * solvers; this one covers the PATIENT — an event with pending `spawn_queue`
 * work and no live solver at all means the fence / drain / platform is stuck,
 * and in an unattended event nobody else would notice.
 *
 * The trigger is deliberately narrow (no false positives on a completed
 * event):
 *
 *   - the event's queue is not paused, and
 *   - it has pending items, and
 *   - it has NO live solver agent, and
 *   - the pending-set fingerprint has not changed for {@link FLEET_STALL_MS}
 *     (a launch, failure, enqueue or removal all count as progress).
 *
 * A stalled event fires ONE urgent `eventStalled` notice per episode, which
 * also wakes the scheduler; state resets the moment a solver appears, the
 * pending set empties, or the queue/scheduler is paused.
 */
export function createFleetWatchdog(deps: FleetWatchdogDeps) {
  const clock = deps.clock ?? systemClock
  const hub = createTimerHub(clock)
  const intervalMs = deps.intervalMs ?? FLEET_WATCHDOG_INTERVAL_MS
  const stallMs = deps.stallMs ?? FLEET_STALL_MS
  const state = new Map<string, ProgressState>()
  let timer: ClockTimer | undefined

  /** Paused events (queue_state='paused'); absent row = running. */
  function pausedEvents(): Set<string> {
    return new Set(
      deps.db
        .select({ eventId: queueState.eventId })
        .from(queueState)
        .where(eq(queueState.status, "paused"))
        .all()
        .map((row) => row.eventId)
    )
  }

  /** Events with at least one live solver. */
  function eventsWithLiveSolver(): Set<string> {
    return new Set(
      deps.db
        .select({ eventId: agents.eventId })
        .from(agents)
        .where(
          and(
            eq(agents.role, "solver"),
            inArray(agents.status, [...LIVE_AGENT_STATUSES])
          )
        )
        .all()
        .map((row) => row.eventId)
    )
  }

  function checkOnce(): void {
    const nowMs = clock.now()
    const pendingRows = deps.db
      .select({
        id: spawnQueue.id,
        eventId: spawnQueue.eventId,
        ord: spawnQueue.ord,
        updatedAt: spawnQueue.updatedAt,
      })
      .from(spawnQueue)
      .where(eq(spawnQueue.status, "pending"))
      .all()
    const pendingByEvent = new Map<string, typeof pendingRows>()
    for (const row of pendingRows) {
      const list = pendingByEvent.get(row.eventId) ?? []
      list.push(row)
      pendingByEvent.set(row.eventId, list)
    }
    const liveEvents = eventsWithLiveSolver()
    const paused = pausedEvents()
    const eventIds = new Set([...pendingByEvent.keys(), ...state.keys()])
    for (const eventId of eventIds) {
      const rows = pendingByEvent.get(eventId) ?? []
      const previous = state.get(eventId)
      if (
        rows.length === 0 ||
        liveEvents.has(eventId) ||
        paused.has(eventId) ||
        deps.isSchedulerPaused(eventId)
      ) {
        state.delete(eventId)
        continue
      }
      const marker = rows
        .map((row) => `${row.id}:${row.ord}:${row.updatedAt}`)
        .toSorted()
        .join("|")
      if (!previous) {
        state.set(eventId, { marker, progressAt: nowMs, fired: false })
        continue
      }
      if (previous.marker !== marker) {
        // A launch / failure / enqueue / removal moved the queue: progress.
        previous.marker = marker
        previous.progressAt = nowMs
        continue
      }
      if (previous.fired) continue
      const stalledMs = nowMs - previous.progressAt
      if (stalledMs < stallMs) continue
      previous.fired = true
      deps.onStalled({ eventId, pending: rows.length, stalledMs })
    }
  }

  function start(): void {
    if (timer) return
    timer = hub.setInterval(checkOnce, intervalMs)
  }

  function close(): void {
    hub.disposeAll()
    timer = undefined
    state.clear()
  }

  return { checkOnce, start, close }
}
