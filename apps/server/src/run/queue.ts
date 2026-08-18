import type { SolverSpec } from "@aegisx/shared"
import type { QueueItemPublic } from "@aegisx/shared/queue"
import { and, asc, count, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "../db"
import { challenges, queueState, runQueue } from "../db/schema"
import { RunActionError } from "./errors"
import { checkLaunchFence, type FenceCandidate } from "./fence"

/** Public queue item shape (REST + tools). Canonical definition lives in
 * @aegisx/shared/queue; re-exported here for server-side importers. */
export type { QueueItemPublic } from "@aegisx/shared/queue"

type QueueRow = typeof runQueue.$inferSelect

/** Statuses visible in the queue view (actionable items; done/cancelled are
 * historical). */
const VISIBLE_STATUSES = ["pending", "running", "failed"] as const

const DRAIN_DEBOUNCE_MS = 200

export type EnqueueInput = {
  eventId: string
  challengeId: string
  /** v9 run-level strategy — rendered into every solver's initial prompt as
   * a `## Strategy` section (the standard blocks stay). Stored in BOTH the
   * `prompt` column (display) and the `params` JSON (launch). */
  strategy?: string
  /** v9 model ref applied to every solver at launch. */
  model?: string
  /** v9 solver count (1..MAX_SOLVERS_PER_RUN). */
  solverCount?: number
  /** v9 per-solver specs — takes precedence over model/solverCount. */
  solvers?: SolverSpec[]
  /** Legacy alias of `strategy` (the HTTP enqueue routes' field name). */
  prompt?: string
  timeoutMs?: number | null
  source: "manual" | "scheduler"
}

/** The v9 launch specs a queue row carries (the parsed `params` JSON column):
 * everything the drainer forwards to resolveAndCreate. */
export type QueueLaunchSpecs = {
  strategy?: string
  model?: string
  solverCount?: number
  solvers?: SolverSpec[]
}

/** Serialize the v9 launch specs into the `params` JSON value. */
function launchParamsOf(
  input: EnqueueInput,
  strategy: string
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (strategy) params.strategy = strategy
  if (input.model) params.model = input.model
  if (input.solverCount !== undefined) params.solverCount = input.solverCount
  if (input.solvers) params.solvers = input.solvers
  return params
}

/** Parse a queue row's `params` JSON into the typed launch specs. Defensive:
 * malformed JSON / wrong shapes drop the affected key (the drainer must not
 * blow up on a hand-edited column). */
export function parseQueueLaunchSpecs(raw: string): QueueLaunchSpecs {
  const parsed = safeParseObject(raw)
  const specs: QueueLaunchSpecs = {}
  if (typeof parsed.strategy === "string" && parsed.strategy) {
    specs.strategy = parsed.strategy
  }
  if (typeof parsed.model === "string" && parsed.model) {
    specs.model = parsed.model
  }
  if (
    typeof parsed.solverCount === "number" &&
    Number.isInteger(parsed.solverCount) &&
    parsed.solverCount > 0
  ) {
    specs.solverCount = parsed.solverCount
  }
  if (Array.isArray(parsed.solvers)) {
    const solvers = parsed.solvers.filter(isSolverSpec)
    if (solvers.length) specs.solvers = solvers
  }
  return specs
}

function isSolverSpec(value: unknown): value is SolverSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const spec = value as Record<string, unknown>
  // At least one known key — an all-unknown object (a typo like `{modle: "x"}`)
  // must not silently become a default solver.
  if (
    spec.model === undefined &&
    spec.prompt === undefined &&
    spec.promptMode === undefined
  ) {
    return false
  }
  return (
    (spec.model === undefined || typeof spec.model === "string") &&
    (spec.prompt === undefined || typeof spec.prompt === "string") &&
    (spec.promptMode === undefined ||
      spec.promptMode === "strategy" ||
      spec.promptMode === "override")
  )
}

export type QueueServiceDeps = {
  db: Database
  getSettings(): import("@aegisx/shared").FlatSettings
  /** Whether the owning service has been closed (drain becomes a no-op). */
  isDisposed(): boolean
  /** Launch one queued item as a run and return its id. Resolves only on
   * success; rejects with {@link RunActionError} (capacity / launch_failed) or
   * other errors. */
  launch(item: QueueRow): Promise<string>
  /** Emergency line for the event's scheduler DM (docs/im-channels.md §三,
   * digest policy — absorbs the former scheduler-inbox): a permanent launch
   * failure, or the queue-starved edge (pending 2→1). Posted as an urgent
   * system message (immediate flush). Never throws. */
  onQueueEmergency(eventId: string, line: string): void
  /** Ordinary notice line for the scheduler DM (queue pause/resume): a
   * non-urgent system message riding the next digest. Never throws. */
  onQueueNotice(eventId: string, line: string): void
}

function toPublic(db: Database, row: QueueRow): QueueItemPublic {
  const challenge = db
    .select({ name: challenges.name })
    .from(challenges)
    .where(eq(challenges.id, row.challengeId))
    .get()
  return {
    id: row.id,
    eventId: row.eventId,
    ord: row.ord,
    challengeId: row.challengeId,
    challengeName: challenge?.name ?? "",
    params: safeParseObject(row.params),
    timeoutMs: row.timeoutMs,
    prompt: row.prompt,
    source: row.source as QueueItemPublic["source"],
    status: row.status as QueueItemPublic["status"],
    runId: row.runId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const now = () => new Date().toISOString()

export function createQueueService(deps: QueueServiceDeps) {
  const { db } = deps

  /** Per-event starved-edge memory: true once pending crossed 2→1 (fired);
   * reset when the count climbs back ≥ 2 (refill re-arms). Edge-triggered so
   * a queue sitting at ≤ 1 never keeps nagging. */
  const starvedFired = new Map<string, boolean>()

  /** Pending items count for an event (queue-starved判定口径). */
  function pendingCount(eventId: string): number {
    return (
      db
        .select({ count: count() })
        .from(runQueue)
        .where(
          and(eq(runQueue.eventId, eventId), eq(runQueue.status, "pending"))
        )
        .get()?.count ?? 0
    )
  }

  /** Check the 2→1 edge on a pending-count DECREASE (launch 拉走 / remove /
   * fail): exactly one pending item left → fire once (the last queued item is
   * the buffer — the scheduler still has one pending + the just-launched run
   * to react within). Never fires for a count that never crossed the edge
   * (initial single-item enqueue, or 2→0 bulk clears). A PAUSED queue stays
   * silent — the user stopped launching on purpose; the edge is still
   * consumed so a resumed queue never nags about it. */
  function checkStarved(eventId: string): void {
    const count = pendingCount(eventId)
    if (count >= 2) {
      starvedFired.set(eventId, false)
      return
    }
    if (count === 1 && !starvedFired.get(eventId)) {
      starvedFired.set(eventId, true)
      if (stateOf(eventId) === "paused") return
      deps.onQueueEmergency(eventId, "队列不足：仅剩 1 项排队")
    }
  }

  /** A launch permanently failed → urgent message for the scheduler DM
   * (digest policy flushes immediately; docs/im-channels.md §三). */
  function launchFailureLine(item: QueueRow, error: string): string {
    const name =
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, item.challengeId))
        .get()?.name ?? item.challengeId
    const brief = error.length > 200 ? `${error.slice(0, 200)}…` : error
    return `启动失败：「${name}」— ${brief}`
  }

  /** Next ord value for an event (max + 1). */
  function nextOrd(eventId: string): number {
    const row = db
      .select({ max: sql<number>`max(${runQueue.ord})` })
      .from(runQueue)
      .where(eq(runQueue.eventId, eventId))
      .get()
    return (row?.max ?? 0) + 1
  }

  function getRow(id: string): QueueRow | undefined {
    return db.select().from(runQueue).where(eq(runQueue.id, id)).get()
  }

  /**
   * Upsert a queue item by `challengeId` (globally unique PK — one pending
   * item per challenge; re-enqueue = re-arm). A hit —
   * including done/cancelled/failed — is reset to pending, runId cleared, and
   * ord/params/prompt/timeoutMs updated; a miss inserts a new row at the end.
   * A running item is rejected (close the run first). */
  function enqueue(input: EnqueueInput): QueueItemPublic {
    const ts = now()
    // The `prompt` column keeps the run-level strategy (display); the v9
    // launch specs (strategy included) live in the `params` JSON for the
    // drainer to forward.
    const strategy = input.strategy ?? input.prompt ?? ""
    const params = JSON.stringify(launchParamsOf(input, strategy))
    const prompt = strategy
    const timeoutMs = input.timeoutMs ?? null
    const existing = db
      .select()
      .from(runQueue)
      .where(eq(runQueue.challengeId, input.challengeId))
      .get()
    if (existing) {
      if (existing.status === "running") {
        throw new RunActionError(
          "invalid_state",
          "Challenge run already in progress — close it or wait for it to finish first"
        )
      }
      // Re-enqueue goes to the back of the queue (FIFO).
      const ord = nextOrd(input.eventId)
      db.update(runQueue)
        .set({
          status: "pending",
          runId: null,
          error: null,
          ord,
          params,
          prompt,
          timeoutMs,
          source: input.source,
          updatedAt: ts,
        })
        .where(eq(runQueue.id, existing.id))
        .run()
      // Enqueue only grows the count; ≥ 2 clears the starved edge so a later
      // 2→1 crossing re-fires (initial single-item enqueue never fires).
      if (pendingCount(input.eventId) >= 2)
        starvedFired.set(input.eventId, false)
      scheduleDrain()
      return toPublic(db, getRow(existing.id)!)
    }
    const id = crypto.randomUUID()
    db.insert(runQueue)
      .values({
        id,
        eventId: input.eventId,
        ord: nextOrd(input.eventId),
        challengeId: input.challengeId,
        params,
        timeoutMs,
        prompt,
        source: input.source,
        status: "pending",
        runId: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run()
    if (pendingCount(input.eventId) >= 2) starvedFired.set(input.eventId, false)
    scheduleDrain()
    return toPublic(db, getRow(id)!)
  }

  /** Actionable items for an event (pending + running + failed), FIFO by ord. */
  function list(eventId: string): QueueItemPublic[] {
    return db
      .select()
      .from(runQueue)
      .where(
        and(
          eq(runQueue.eventId, eventId),
          inArray(runQueue.status, [...VISIBLE_STATUSES])
        )
      )
      .orderBy(asc(runQueue.ord), asc(runQueue.createdAt))
      .all()
      .map((row) => toPublic(db, row))
  }

  /** Remove an item. Running items cannot be deleted. */
  function remove(itemId: string): void {
    const row = getRow(itemId)
    if (!row) throw new RunActionError("not_found", "Queue item not found")
    if (row.status === "running") {
      throw new RunActionError(
        "invalid_state",
        "Cannot remove a running queue item; close its run first"
      )
    }
    db.delete(runQueue).where(eq(runQueue.id, itemId)).run()
    checkStarved(row.eventId)
  }

  /** Remove every non-running item for an event. */
  function clear(eventId: string): void {
    db.delete(runQueue)
      .where(
        and(eq(runQueue.eventId, eventId), sql`${runQueue.status} != 'running'`)
      )
      .run()
  }

  /** Fully-solved cleanup: cancel the challenge's pending items (stale work
   * — a later re-enqueue resets them via the upsert). Returns the cancelled
   * count. Running items are untouched (their runs close via teardown). */
  function cancelPendingForChallenge(
    eventId: string,
    challengeId: string
  ): number {
    const rows = db
      .select({ id: runQueue.id })
      .from(runQueue)
      .where(
        and(
          eq(runQueue.challengeId, challengeId),
          eq(runQueue.status, "pending")
        )
      )
      .all()
    if (!rows.length) return 0
    db.update(runQueue)
      .set({ status: "cancelled", updatedAt: now() })
      .where(
        and(
          eq(runQueue.challengeId, challengeId),
          eq(runQueue.status, "pending")
        )
      )
      .run()
    checkStarved(eventId)
    return rows.length
  }

  /** Update a pending item's prompt / timeout / params. Only
   * pending items are editable; running/done/failed reject. */
  function update(
    itemId: string,
    patch: {
      prompt?: string
      timeoutMs?: number | null
      params?: Record<string, unknown>
    }
  ): QueueItemPublic {
    const row = getRow(itemId)
    if (!row) throw new RunActionError("not_found", "Queue item not found")
    if (row.status !== "pending") {
      throw new RunActionError(
        "invalid_state",
        "Only pending queue items can be edited"
      )
    }
    const set: Partial<typeof runQueue.$inferInsert> = { updatedAt: now() }
    if (patch.prompt !== undefined) set.prompt = patch.prompt
    if (patch.timeoutMs !== undefined) set.timeoutMs = patch.timeoutMs
    if (patch.params !== undefined) set.params = JSON.stringify(patch.params)
    db.update(runQueue).set(set).where(eq(runQueue.id, itemId)).run()
    return toPublic(db, getRow(itemId)!)
  }

  /** Reassign ord by position. Only pending items may be reordered; running
   * items keep their place. Items must belong to the event. */
  function reorder(eventId: string, itemIds: string[]): void {
    const ts = now()
    itemIds.forEach((id, index) => {
      const row = getRow(id)
      if (!row || row.eventId !== eventId) {
        throw new RunActionError("not_found", `Queue item not found: ${id}`)
      }
      if (row.status !== "pending") return
      db.update(runQueue)
        .set({ ord: index + 1, updatedAt: ts })
        .where(eq(runQueue.id, id))
        .run()
    })
  }

  /** Pending items across all events, FIFO by ord (global drain order).
   *
   * Events paused via {@link queue_state} are skipped (their pending items
   * stay put — enqueue/edit/reorder/remove still work, only launching is
   * blocked until resume).
   *
   * Note (accepted decision): `ord` is PER-EVENT (nextOrd scopes by eventId,
   * reorder too), so this cross-event ordering is only approximate — the
   * drainer does not promise strict cross-event FIFO. That is fine: the order
   * is non-starvation (a low-ord item is always launchable once capacity
   * frees; no item is skipped forever) and single-user has no cross-event
   * fairness requirement. A global ord was deliberately NOT introduced — it
   * would break the per-event reorder semantics. */
  function pendingItems(): QueueRow[] {
    const rows = db
      .select({ item: runQueue })
      .from(runQueue)
      .leftJoin(queueState, eq(queueState.eventId, runQueue.eventId))
      .where(
        and(
          eq(runQueue.status, "pending"),
          sql`${queueState.status} is null or ${queueState.status} != 'paused'`
        )
      )
      .orderBy(asc(runQueue.ord), asc(runQueue.createdAt))
      .all()
    return rows.map((row) => row.item)
  }

  /** Mark an item running once its run launched (back-fills runId). */
  function markRunning(itemId: string, runId: string): void {
    const row = getRow(itemId)
    db.update(runQueue)
      .set({ status: "running", runId, error: null, updatedAt: now() })
      .where(and(eq(runQueue.id, itemId), eq(runQueue.status, "pending")))
      .run()
    if (row) checkStarved(row.eventId)
  }

  /** Mark an item failed (launch error recorded). */
  function markFailed(itemId: string, error: string): void {
    const row = getRow(itemId)
    db.update(runQueue)
      .set({ status: "failed", error, updatedAt: now() })
      .where(eq(runQueue.id, itemId))
      .run()
    if (row) checkStarved(row.eventId)
  }

  /**
   * Transition a run's queue item to done, guarded by `(id, runId, running)`.
   * Called from run teardown; a no-op for runs not launched from
   * the queue (no queueItemId) or already-transitioned items.
   */
  function markDone(
    queueItemId: string | null | undefined,
    runId: string
  ): void {
    if (!queueItemId) return
    db.update(runQueue)
      .set({ status: "done", updatedAt: now() })
      .where(
        and(
          eq(runQueue.id, queueItemId),
          eq(runQueue.runId, runId),
          eq(runQueue.status, "running")
        )
      )
      .run()
  }

  // --- drainer (single-flight, debounced) --------------------------------

  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let draining = false

  function candidateFromItem(item: QueueRow): FenceCandidate {
    return {
      scopeType: "challenge",
      eventId: item.eventId,
      challengeId: item.challengeId,
    }
  }

  /** Debounced drain: collapses a burst of triggers (enqueue / run release /
   * boot) into one pass. */
  function scheduleDrain(): void {
    if (drainTimer) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      void drainOnce().catch(() => undefined)
    }, DRAIN_DEBOUNCE_MS)
  }

  /**
   * One drain pass over pending items in FIFO order. For each item:
   *  - fence ok → launch; on success mark running; on a (racy) capacity reject
   *    leave it pending; on other errors mark failed + notify the scheduler.
   *  - global_capacity → stop the pass (no later item can launch either).
   *  - target_slots → skip (a different challenge/event may still launch).
   * Single-flight: a pass already in progress ignores new triggers (the
   * trailing trigger schedules a fresh debounced pass).
   */
  async function drainOnce(): Promise<void> {
    if (draining || deps.isDisposed()) return
    draining = true
    try {
      for (const item of pendingItems()) {
        const decision = checkLaunchFence(
          db,
          deps.getSettings(),
          candidateFromItem(item)
        )
        if (!decision.ok) {
          // Global cap is saturated for the whole pass; nothing else launches.
          if (decision.code === "global_capacity") return
          // Per-event target cap: only this item is blocked; try the rest.
          continue
        }
        try {
          const runId = await deps.launch(item)
          markRunning(item.id, runId)
        } catch (error) {
          if (isCapacity(error)) continue // race with another launch; stay pending
          const message = error instanceof Error ? error.message : String(error)
          markFailed(item.id, message)
          deps.onQueueEmergency(item.eventId, launchFailureLine(item, message))
        }
      }
    } finally {
      draining = false
    }
  }

  /** Cancel any pending debounced drain (called from the service close so a
   * draining timer does not fire against a disposed service/db). */
  function cancelDrain(): void {
    if (drainTimer) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  // --- per-event queue state (W2) -----------------------------------------
  // Absent row = `running` (a fresh event's queue drains immediately). pause
  // blocks FUTURE launches only — already-running runs keep going (pause ≠
  // kill) and enqueue/edit/reorder/remove still work.

  function stateOf(eventId: string): "running" | "paused" {
    const row = db
      .select({ status: queueState.status })
      .from(queueState)
      .where(eq(queueState.eventId, eventId))
      .get()
    return row?.status === "paused" ? "paused" : "running"
  }

  function setState(eventId: string, status: "running" | "paused"): void {
    const ts = now()
    db.insert(queueState)
      .values({ eventId, status, updatedAt: ts })
      .onConflictDoUpdate({
        target: queueState.eventId,
        set: { status, updatedAt: ts },
      })
      .run()
  }

  /** Notice line for a state flip; `manual` marks a user-driven flip so the
   * scheduler can tell its own actions from user intervention. */
  function stateNotice(action: string, source: "manual" | "scheduler"): string {
    return source === "manual"
      ? `队列已${action}（用户手动）`
      : `队列已${action}`
  }

  function pause(
    eventId: string,
    source: "manual" | "scheduler" = "manual"
  ): void {
    // Idempotent: a repeat flip keeps silent (no duplicate notice lines).
    if (stateOf(eventId) === "paused") return
    setState(eventId, "paused")
    deps.onQueueNotice(eventId, stateNotice("暂停", source))
  }

  function resume(
    eventId: string,
    source: "manual" | "scheduler" = "manual"
  ): void {
    if (stateOf(eventId) === "running") return
    setState(eventId, "running")
    deps.onQueueNotice(eventId, stateNotice("恢复", source))
  }

  return {
    enqueue,
    list,
    remove,
    clear,
    cancelPendingForChallenge,
    update,
    reorder,
    markDone,
    scheduleDrain,
    drainOnce,
    cancelDrain,
    pause,
    resume,
    stateOf,
  }
}

export type QueueService = ReturnType<typeof createQueueService>

function isCapacity(error: unknown): boolean {
  return (
    error instanceof RunActionError &&
    (error as RunActionError).code === "capacity"
  )
}
