import { isRecord } from "@aegisx/shared"
import type { QueueItemPublic, SpawnQueueParams } from "@aegisx/shared/queue"
import { and, asc, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"

import type { Database } from "../db"
import { challenges, queueState, spawnQueue } from "../db/schema"
import type { Principal } from "../infrastructure/agent-auth"
import { parseJson } from "../lib/guards"
import { logEvent } from "../lib/log"
import type { Clock } from "./clock"
import { createQueueDrainer } from "./drainer"
import { RunActionError } from "./errors"
import type { NoticeEvent } from "./orch-notices"
import { assertMayTouchEvent } from "./principal-scope"

/** Public queue item shape (REST + tools). Canonical definition lives in
 * @aegisx/shared/queue; re-exported here for server-side importers. */
export type { QueueItemPublic } from "@aegisx/shared/queue"

type QueueRow = typeof spawnQueue.$inferSelect

/** Statuses visible in the queue view (actionable items; done/cancelled are
 * historical). */
const VISIBLE_STATUSES = ["pending", "running", "failed"] as const

export type EnqueueInput = {
  eventId: string
  challengeId: string
  /** The spawn prompt (strategy input for the agent's first turn). The
   * `prompt` column is its single home — the params JSON never carries it. */
  prompt?: string
  /** Spawn model ref override. */
  model?: string
  /** 'strategy' (default) appends the prompt to the initial template's
   * Strategy section; 'override' replaces the initial prompt entirely. */
  promptMode?: "strategy" | "override"
  timeoutMs?: number | null
  source: "manual" | "scheduler"
}

/** Serialize the spawn specs into the `params` JSON value (prompt excluded —
 * the `prompt` column owns it). */
function launchParamsOf(input: EnqueueInput): Record<string, unknown> {
  const params: SpawnQueueParams = {}
  if (input.model) params.model = input.model
  if (input.promptMode) params.promptMode = input.promptMode
  return params
}

/** Parse a queue row's `params` JSON into the typed spawn specs. Defensive:
 * malformed JSON / wrong shapes drop the affected key (the drainer must not
 * blow up on a hand-edited column). A stale `prompt` key (pre-single-source
 * rows) is ignored — the column wins. */
export function parseSpawnQueueParams(raw: string): SpawnQueueParams {
  const parsed = safeParseObject(raw)
  const params: SpawnQueueParams = {}
  if (typeof parsed.model === "string" && parsed.model) {
    params.model = parsed.model
  }
  if (parsed.promptMode === "strategy" || parsed.promptMode === "override") {
    params.promptMode = parsed.promptMode
  }
  return params
}

export type QueueServiceDeps = {
  db: Database
  getSettings(): import("@aegisx/shared").FlatSettings
  /** Whether the owning service has been closed (drain becomes a no-op). */
  isDisposed(): boolean
  /** Spawn one agent for a queued item and return its id. Resolves only on
   * success; rejects with {@link RunActionError} (capacity /
   * launch_failed) or other errors. */
  launch(item: QueueRow): Promise<string>
  /** Emergency notice for the event's scheduler: a permanent launch failure,
   * or the queue-starved edge (pending 2→1). Posted urgent (immediate wake).
   * Never throws. */
  onQueueEmergency(event: NoticeEvent): void
  /** Ordinary notice for the event's scheduler (queue pause/resume): a
   * non-urgent message riding the next delivery. Never throws. */
  onQueueNotice(event: NoticeEvent): void
  /** Settle a just-spawned agent whose queue item was cancelled/removed
   * mid-launch (markRunning lost the race). Never throws; failures are
   * logged by the drainer. */
  onSupersededLaunch?: (agentId: string) => void | Promise<void>
  /** Time layer for the drainer (default: the system clock). */
  clock?: Clock
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
    params: parseSpawnQueueParams(row.params),
    timeoutMs: row.timeoutMs,
    prompt: row.prompt,
    source: row.source,
    status: row.status,
    agentId: row.agentId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = parseJson<unknown>(raw)
    return isRecord(parsed) ? parsed : {}
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
        .from(spawnQueue)
        .where(
          and(eq(spawnQueue.eventId, eventId), eq(spawnQueue.status, "pending"))
        )
        .get()?.count ?? 0
    )
  }

  /** Check the 2→1 edge on a pending-count DECREASE (spawn 拉走 / remove /
   * fail): exactly one pending item left → fire once. A PAUSED queue stays
   * silent — the user stopped launching on purpose; the edge is still
   * consumed so a resumed queue never nags about it. */
  function checkStarved(eventId: string): void {
    const pending = pendingCount(eventId)
    if (pending >= 2) {
      starvedFired.set(eventId, false)
      return
    }
    if (pending === 1 && !starvedFired.get(eventId)) {
      starvedFired.set(eventId, true)
      // Internal caller — the system principal passes the event scope free
      // of charge; the assertion only gates external (route) callers.
      if (stateOf(eventId, { kind: "system" }) === "paused") return
      logEvent("queue", "starved", { pending })
      deps.onQueueEmergency({ type: "queueStarved", eventId, pending })
    }
  }

  /** Challenge display name for log lines; id prefix when unbound. */
  function challengesName(challengeId: string): string {
    return (
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()?.name ?? challengeId.slice(0, 8)
    )
  }

  /** Next ord value for an event (max + 1). */
  function nextOrd(eventId: string): number {
    const row = db
      .select({ max: sql<number>`max(${spawnQueue.ord})` })
      .from(spawnQueue)
      .where(eq(spawnQueue.eventId, eventId))
      .get()
    return (row?.max ?? 0) + 1
  }

  function getRow(id: string): QueueRow | undefined {
    return db.select().from(spawnQueue).where(eq(spawnQueue.id, id)).get()
  }

  /**
   * Append a spawn item (v19 semantics: ALWAYS append — one challenge may
   * hold several pending items; parallel attempts are a legal plan). The
   * principal is scope-checked against the event, and the challenge must
   * belong to the event's queue it lands in (data integrity, enforced here
   * rather than per-route).
   */
  function enqueue(input: EnqueueInput, principal: Principal): QueueItemPublic {
    assertMayTouchEvent(principal, input.eventId)
    const challenge = db
      .select({ eventId: challenges.eventId })
      .from(challenges)
      .where(eq(challenges.id, input.challengeId))
      .get()
    if (!challenge || challenge.eventId !== input.eventId) {
      throw new RunActionError(
        "invalid",
        "Challenge does not belong to this event"
      )
    }
    const ts = now()
    const id = crypto.randomUUID()
    const ord = nextOrd(input.eventId)
    db.insert(spawnQueue)
      .values({
        id,
        eventId: input.eventId,
        ord,
        challengeId: input.challengeId,
        params: JSON.stringify(launchParamsOf(input)),
        timeoutMs: input.timeoutMs ?? null,
        prompt: input.prompt ?? "",
        source: input.source,
        status: "pending",
        agentId: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run()
    logEvent("queue", "enqueued", {
      challenge: challengesName(input.challengeId),
      ord,
      promptLen: (input.prompt ?? "").length,
      source: input.source,
    })
    // Enqueue only grows the count; ≥ 2 clears the starved edge so a later
    // 2→1 crossing re-fires.
    if (pendingCount(input.eventId) >= 2) starvedFired.set(input.eventId, false)
    drainer.scheduleDrain()
    return toPublic(db, getRow(id)!)
  }

  /** Actionable items for an event (pending + running + failed), FIFO by ord. */
  function list(eventId: string, principal: Principal): QueueItemPublic[] {
    assertMayTouchEvent(principal, eventId)
    return db
      .select()
      .from(spawnQueue)
      .where(
        and(
          eq(spawnQueue.eventId, eventId),
          inArray(spawnQueue.status, [...VISIBLE_STATUSES])
        )
      )
      .orderBy(asc(spawnQueue.ord), asc(spawnQueue.createdAt))
      .all()
      .map((row) => toPublic(db, row))
  }

  /** Remove an item of `eventId`. Running items cannot be deleted; an item
   * from another event is indistinguishable from a missing one (P0-8: the
   * event scope is enforced HERE, not at the route). */
  function remove(eventId: string, itemId: string, principal: Principal): void {
    assertMayTouchEvent(principal, eventId)
    const row = getRow(itemId)
    if (!row || row.eventId !== eventId) {
      throw new RunActionError("not_found", "Queue item not found")
    }
    if (row.status === "running") {
      throw new RunActionError(
        "invalid_state",
        "Cannot remove a running queue item; close its agent first"
      )
    }
    db.delete(spawnQueue).where(eq(spawnQueue.id, itemId)).run()
    checkStarved(row.eventId)
  }

  /** Remove every non-running item for an event. */
  function clear(eventId: string, principal: Principal): void {
    assertMayTouchEvent(principal, eventId)
    db.delete(spawnQueue)
      .where(
        and(eq(spawnQueue.eventId, eventId), ne(spawnQueue.status, "running"))
      )
      .run()
  }

  /** Fully-solved cleanup: cancel the challenge's pending items (stale
   * work). Returns the cancelled count. Running items are untouched (their
   * agents stop via the solve cleanup). */
  function cancelPendingForChallenge(
    eventId: string,
    challengeId: string
  ): number {
    const rows = db
      .select({ id: spawnQueue.id })
      .from(spawnQueue)
      .where(
        and(
          eq(spawnQueue.challengeId, challengeId),
          eq(spawnQueue.status, "pending")
        )
      )
      .all()
    if (!rows.length) return 0
    db.update(spawnQueue)
      .set({ status: "cancelled", updatedAt: now() })
      .where(
        and(
          eq(spawnQueue.challengeId, challengeId),
          eq(spawnQueue.status, "pending")
        )
      )
      .run()
    checkStarved(eventId)
    return rows.length
  }

  /** Update a pending item's prompt / timeout / params. Only
   * pending items are editable; running/done/failed reject. The item is
   * addressed as (eventId, itemId) — same-event scoping like remove/reorder,
   * so a cross-event edit is a not_found and an out-of-event principal is
   * forbidden. */
  function update(
    eventId: string,
    itemId: string,
    patch: {
      prompt?: string
      timeoutMs?: number | null
      params?: Record<string, unknown>
    },
    principal: Principal
  ): QueueItemPublic {
    assertMayTouchEvent(principal, eventId)
    const row = getRow(itemId)
    if (!row || row.eventId !== eventId) {
      throw new RunActionError("not_found", "Queue item not found")
    }
    if (row.status !== "pending") {
      throw new RunActionError(
        "invalid_state",
        "Only pending queue items can be edited"
      )
    }
    const set: Partial<typeof spawnQueue.$inferInsert> = { updatedAt: now() }
    if (patch.prompt !== undefined) set.prompt = patch.prompt
    if (patch.timeoutMs !== undefined) set.timeoutMs = patch.timeoutMs
    if (patch.params !== undefined) set.params = JSON.stringify(patch.params)
    db.update(spawnQueue).set(set).where(eq(spawnQueue.id, itemId)).run()
    return toPublic(db, getRow(itemId)!)
  }

  /** Reassign ord by position. Only pending items may be reordered; running
   * items keep their place. Items must belong to the event. */
  function reorder(
    eventId: string,
    itemIds: string[],
    principal: Principal
  ): void {
    assertMayTouchEvent(principal, eventId)
    const ts = now()
    itemIds.forEach((id, index) => {
      const row = getRow(id)
      if (!row || row.eventId !== eventId) {
        throw new RunActionError("not_found", `Queue item not found: ${id}`)
      }
      if (row.status !== "pending") return
      db.update(spawnQueue)
        .set({ ord: index + 1, updatedAt: ts })
        .where(eq(spawnQueue.id, id))
        .run()
    })
  }

  /** Pending items across all events, FIFO by ord (global drain order).
   *
   * Events paused via {@link queue_state} are skipped (their pending items
   * stay put — enqueue/edit/reorder/remove still work, only launching is
   * blocked until resume).
   *
   * Note (accepted decision): `ord` is PER-EVENT, so this cross-event
   * ordering is only approximate — the drainer promises non-starvation, not
   * strict cross-event FIFO. */
  function pendingItems(): QueueRow[] {
    const rows = db
      .select({ item: spawnQueue })
      .from(spawnQueue)
      .leftJoin(queueState, eq(queueState.eventId, spawnQueue.eventId))
      .where(
        and(
          eq(spawnQueue.status, "pending"),
          // Parenthesized deliberately: as a raw sql fragment `a or b` sits
          // at the top level of the AND chain, and since AND binds tighter
          // than OR the whole predicate degrades to `status='pending' AND x
          // IS NULL OR x != 'paused'` — true for every row once a running
          // queue_state exists, so the drainer re-launched done/cancelled
          // items forever. or(...) keeps the group nested.
          or(isNull(queueState.status), ne(queueState.status, "paused"))
        )
      )
      .orderBy(asc(spawnQueue.ord), asc(spawnQueue.createdAt))
      .all()
    return rows.map((row) => row.item)
  }

  /** Mark an item running once its agent spawned (back-fills agentId).
   * Returns false when the guarded update matched nothing — the item was
   * cancelled/removed while the launch ran (e.g. full-solve cleanup won the
   * race) — telling the drainer the just-spawned agent is superseded. */
  function markRunning(itemId: string, agentId: string): boolean {
    const row = getRow(itemId)
    const won =
      db
        .update(spawnQueue)
        .set({ status: "running", agentId, error: null, updatedAt: now() })
        .where(and(eq(spawnQueue.id, itemId), eq(spawnQueue.status, "pending")))
        .returning({ id: spawnQueue.id })
        .get() !== undefined
    if (row) checkStarved(row.eventId)
    return won
  }

  /** Mark an item failed (launch error recorded). */
  function markFailed(itemId: string, error: string): void {
    const row = getRow(itemId)
    db.update(spawnQueue)
      .set({ status: "failed", error, updatedAt: now() })
      .where(eq(spawnQueue.id, itemId))
      .run()
    if (row) checkStarved(row.eventId)
  }

  /** Cancel one item — stale work (the challenge is solved; the full-solve
   * notice already went out), dropped silently rather than recorded failed. */
  function markCancelled(itemId: string): void {
    const row = getRow(itemId)
    db.update(spawnQueue)
      .set({ status: "cancelled", updatedAt: now() })
      .where(eq(spawnQueue.id, itemId))
      .run()
    if (row) checkStarved(row.eventId)
  }

  /**
   * Transition an agent's queue item to done, guarded by `(id, agentId,
   * running)`. Called from the agent's terminal settle; a no-op for agents
   * not spawned from the queue (no queueItemId) or already-transitioned
   * items.
   */
  function markDone(
    queueItemId: string | null | undefined,
    agentId: string
  ): void {
    if (!queueItemId) return
    db.update(spawnQueue)
      .set({ status: "done", updatedAt: now() })
      .where(
        and(
          eq(spawnQueue.id, queueItemId),
          eq(spawnQueue.agentId, agentId),
          eq(spawnQueue.status, "running")
        )
      )
      .run()
  }

  /** Boot recovery: a `running` item's agent was mid-flight at the crash;
   * reset it to pending so a future resume re-launches (the old agent row
   * stays in history). */
  function resetRunning(eventId: string, ts: string): void {
    db.update(spawnQueue)
      .set({ status: "pending", agentId: null, updatedAt: ts })
      .where(
        and(eq(spawnQueue.eventId, eventId), eq(spawnQueue.status, "running"))
      )
      .run()
  }

  // --- drainer (single-flight, debounced) --------------------------------
  // The drain loop lives in drainer.ts; the queue supplies its store half
  // (the pending snapshot + the status writes it drives).

  const drainer = createQueueDrainer({
    db,
    getSettings: () => deps.getSettings(),
    isDisposed: () => deps.isDisposed(),
    launch: (item) => deps.launch(item),
    onEmergency: (eventId, failure) =>
      deps.onQueueEmergency({ type: "launchFailed", eventId, ...failure }),
    ...(deps.onSupersededLaunch
      ? { onSupersededLaunch: deps.onSupersededLaunch }
      : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    store: { pendingItems, markRunning, markFailed, markCancelled },
  })

  /** Drop per-event in-memory bookkeeping (starved edge memory). The DB rows
   * cascade away with the event; only this map would linger. */
  function forget(eventId: string): void {
    starvedFired.delete(eventId)
  }

  // --- per-event queue state (W2) -----------------------------------------
  // Absent row = `running` (a fresh event's queue drains immediately). pause
  // blocks FUTURE launches only — already-live agents keep going (pause ≠
  // kill) and enqueue/edit/reorder/remove still work.

  function stateOf(
    eventId: string,
    principal: Principal
  ): "running" | "paused" {
    assertMayTouchEvent(principal, eventId)
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

  function pause(
    eventId: string,
    source: "manual" | "scheduler",
    principal: Principal
  ): void {
    assertMayTouchEvent(principal, eventId)
    // Idempotent: a repeat flip keeps silent (no duplicate notice lines).
    if (stateOf(eventId, principal) === "paused") return
    setState(eventId, "paused")
    deps.onQueueNotice({
      type: "queueStateChanged",
      eventId,
      action: "paused",
      source,
    })
  }

  function resume(
    eventId: string,
    source: "manual" | "scheduler",
    principal: Principal
  ): void {
    assertMayTouchEvent(principal, eventId)
    if (stateOf(eventId, principal) === "running") return
    setState(eventId, "running")
    deps.onQueueNotice({
      type: "queueStateChanged",
      eventId,
      action: "resumed",
      source,
    })
  }

  return {
    enqueue,
    list,
    remove,
    clear,
    cancelPendingForChallenge,
    markCancelled,
    update,
    reorder,
    markDone,
    resetRunning,
    scheduleDrain: drainer.scheduleDrain,
    drainOnce: drainer.drainOnce,
    cancelDrain: drainer.cancelDrain,
    forget,
    pause,
    resume,
    stateOf,
  }
}

export type QueueService = ReturnType<typeof createQueueService>
