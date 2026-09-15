import { isRecord } from "@aegisx/shared"
import { and, eq } from "drizzle-orm"

import type { Database } from "../../db"
import { agents, decisionState, queueState } from "../../db/schema"
import { logEvent } from "../../lib/log"
import { FLUSH_INTERVAL_MS } from "../channels-context"
import type { Clock } from "../clock"
import { DECISION_TRIGGER_KINDS } from "../domain-events/registry"
import { emitDomainEvent } from "../domain-events/store"
import { createEffects } from "../effects"
import { fmtMs } from "../kernel"
import type { SendOutcome } from "../kernel"

/**
 * The decision-point engine (control-plane design §3.6): the deterministic
 * half of the scheduling loop. Triggers (solver settles, flags, queue
 * changes, asks, the wall clock, boot) coalesce into decision points; the
 * engine drives ONE scheduler turn per decision point — a payload message
 * injected straight into the session (never a channel row) whose facts plus
 * the fleet digest are the decision's inputs — and correlates the turn's
 * outcome: an accepted `submit_plan` TOOL call (B 批 — the native host tool,
 * in-turn) closes the point `plan` (an explicit noOp IS a plan); a silent
 * turn gets ONE strict re-prompt, then closes `violation`; consecutive
 * violations escalate (`watchdog.escalated` + the urgent orch notice). An
 * all-noOp close arms the stall episode (§3.7 r1): a situation still
 * fingerprint-identical after `stallMs` escalates the same alarm once per
 * episode — the per-agent stall watchdog contracted into the engine
 * (escalation keys on decision-point outcomes, never on an idle agent
 * alone). A failed turn (provider error) is never a violation — the same
 * point re-issues after a bounded backoff (byte-identical to the
 * pre-tool path, even when a plan already applied).
 *
 * Plan correlation is turn-generation-based (B 批): the submit_plan tool
 * handler REGISTERS (schedulerAgentId, turnGeneration) whenever its plan's
 * proposal landed; registration is NOT consumption — consumption happens only
 * at the scheduler's CLEAN settle of the open point's turn, only while
 * `open.awaiting`, and only when the registration's generation matches the
 * settling turn's. Mismatched or stale registrations are discarded and the
 * violation ladder proceeds exactly as if no plan had arrived. Plans
 * submitted through the HTTP endpoint (user/system escape hatch — and the
 * scheduler's own legacy face) do NOT register and never close a point.
 *
 * State is durable (C 批): every accepted trigger, open, flush, re-prompt and
 * close is a domain fact, projected into `decision_state` in the append
 * transaction; the engine hydrates those rows at construction, so violations,
 * stall episodes, the quiet fingerprint and pending triggers survive a
 * restart (errorRetries stays memory-only — a bounded, lossy retry budget).
 * boot.resync is narrowed accordingly: only events with hydrated unfinished
 * business or a scheduler whose turn the restart interrupted (kernel's
 * running→idle flips) pay a re-sync turn — a quiet idle event restarts free.
 *
 * The engine is the ONE wake gate for the scheduler: queue paused or
 * scheduler paused (W3) → no decision points, no violation escalation. The
 * delivery engine keeps no scheduler face anymore; the per-event pause/hold
 * plumbing collapsed into these gates.
 */

/** Test-tunable timings; defaults keep production behavior. */
export type DecisionTimings = {
  /** Coalescing window for non-urgent triggers (urgent ones flush at once). */
  coalesceMs: number
  /** Backoff before a failed decision point re-issues. */
  errorRetryMs: number
  /** Periodic re-examination cadence (the old delivery heartbeat slot). */
  periodicMs: number
  /** §3.7 r1: a noOp'd situation persisting this long escalates once (the
   * per-agent stall watchdog contracted into the engine). */
  stallMs: number
  /** Consecutive violations before the escalation alarm fires. */
  violationsToEscalate: number
  /** Failed-turn re-issues before a decision point gives up (outcome=error). */
  maxErrorRetries: number
}

const DEFAULT_TIMINGS: DecisionTimings = {
  coalesceMs: 2_000,
  errorRetryMs: 5_000,
  periodicMs: FLUSH_INTERVAL_MS,
  stallMs: 2 * 60_000,
  violationsToEscalate: 3,
  maxErrorRetries: 2,
}

/** The shipped timing seam (§3.7): the old per-agent watchdog's 2-minute
 * stall threshold lives on here as the engine's `stallMs` default. */
export { DEFAULT_TIMINGS }

/** The engine's two alarm faces (each lands as a watchdog.escalated fact +
 * the urgent orch notice through the dep): the violation ladder's bound, and
 * a noOp'd situation that persisted ≥ stallMs (§3.7 r1 — the per-agent stall
 * watchdog's contraction; escalation keys on decision-point outcomes, never
 * on an idle agent alone). */
export type DecisionEscalation =
  | {
      reason: "scheduler_violation"
      decisionPointId: string
      consecutive: number
    }
  | {
      reason: "scheduler_stalled"
      decisionPointId: string
      stalledMs: number
    }

/** One thing the scheduler should look at. Facts ride the trigger; the
 * payload renders them as readable lines. */
export type DecisionTrigger =
  | { kind: "agent.settled"; agentId: string; status: string }
  | {
      kind: "flag.accepted"
      challengeName: string
      tier: "first" | "extra" | "partial"
    }
  | {
      kind: "queue.changed"
      reason: "enqueued" | "low_water" | "paused" | "resumed"
      pending?: number
    }
  | { kind: "launch.failed"; challengeName: string; error: string }
  | { kind: "agent.timedOut"; agentId: string; outcome: string }
  | {
      kind: "user.directive"
      source: "dm" | "orch" | "resume"
      preview?: string
      /** A terminal scheduler may be cold-revived (startScheduler reopen). */
      revive?: boolean
    }
  | { kind: "solver.asked"; authorAgentId?: string; preview?: string }
  | { kind: "fleet.stalled"; pending: number; stalledMs: number }
  | { kind: "periodic" }
  | { kind: "boot.resync" }

/** Urgent triggers flush immediately (no coalescing window) — the spec's
 * first-flag / launch-failure rule plus the user- and boot-initiated wakes. */
function isUrgentTrigger(t: DecisionTrigger): boolean {
  if (t.kind === "flag.accepted" && t.tier === "first") return true
  return (
    t.kind === "launch.failed" ||
    t.kind === "agent.timedOut" ||
    t.kind === "user.directive" ||
    t.kind === "boot.resync"
  )
}

/** The readable fact line for the payload and the decision_point.opened
 * trigger list (the decision log's display form). */
function triggerLine(t: DecisionTrigger): string {
  switch (t.kind) {
    case "agent.settled":
      return `agent.settled：agent-${t.agentId.slice(0, 8)}（${t.status}）`
    case "flag.accepted":
      return `flag.accepted：「${t.challengeName}」${
        t.tier === "first"
          ? "首次解出"
          : t.tier === "extra"
            ? "新增 flag"
            : "部分解出（多 flag）"
      }`
    case "queue.changed": {
      const label =
        t.reason === "enqueued"
          ? "新排队项"
          : t.reason === "low_water"
            ? "队列低水位"
            : t.reason === "paused"
              ? "队列已暂停"
              : "队列已恢复"
      return `queue.changed：${label}${t.pending !== undefined ? `（待发 ${t.pending}）` : ""}`
    }
    case "launch.failed":
      return `launch.failed：「${t.challengeName}」${t.error}`
    case "agent.timedOut":
      return `agent.timedOut：agent-${t.agentId.slice(0, 8)}（${t.outcome}）`
    case "user.directive":
      return `user.directive：${
        t.source === "dm"
          ? "用户私信"
          : t.source === "resume"
            ? "调度已恢复，请重新同步状态（aegisx.snapshot()）后再行动"
            : "用户在 orch 留言"
      }${t.preview ? ` — ${t.preview}` : ""}`
    case "solver.asked":
      return `solver.asked：${
        t.authorAgentId ? `agent-${t.authorAgentId.slice(0, 8)} ` : ""
      }orch 有未读内容${t.preview ? ` — ${t.preview}` : ""}`
    case "fleet.stalled":
      return `fleet.stalled：${t.pending} 项排队待发，排水已 ${fmtMs(t.stalledMs)} 无进展`
    case "periodic":
      return "periodic：例行复核（自上次决策以来局面有变化）"
    case "boot.resync":
      return "boot.resync：服务已重启，请重新同步状态（aegisx.snapshot()）并决定是否续派"
  }
  return assertNever(t)
}

function assertNever(_t: never): never {
  throw new Error("unreachable trigger kind")
}

/** One open decision point's in-flight state. */
type OpenPoint = {
  id: string
  triggers: DecisionTrigger[]
  phase: "turn" | "reprompt"
  /** In-memory only, lossy by design (C 批 §4.1): a crash resets the backoff
   * count, so a hydrated point re-issues within maxErrorRetries once more —
   * a bounded retry-budget drift, never a correctness one. */
  errorRetries: number
  /** A payload turn is in flight (its settle correlates to this point). */
  awaiting: boolean
  digest: string
}

type EventState = {
  pending: DecisionTrigger[]
  open: OpenPoint | null
  /** Consecutive no-plan closes since the last plan (or escalation). */
  violations: number
  /** Fleet fingerprint at the last explicit no-decision close — the
   * periodic trigger skips while the fingerprint is unchanged (§3.6 r4). */
  quietFingerprint: string | null
  /** The quiet-stall episode (§3.7 r1): armed by an all-noOp close, cleared
   * by a real plan or a moved situation, escalating once per episode after
   * stallMs of an unchanged fingerprint. */
  stall: {
    pointId: string
    sinceMs: number
    fingerprint: string
    escalated: boolean
  } | null
}

export type DecisionPointEngine = ReturnType<typeof createDecisionPointEngine>

const TRIGGER_KINDS = new Set<string>(DECISION_TRIGGER_KINDS)

/** The durable half's decode side (C 批): decision_state rows hydrate the
 * in-memory states at construction — memory stays the working representation,
 * the projection is what survives a restart. Both parsers bound the damage a
 * corrupted row can do (the rows were written from validated payloads). */
function parseTriggers(raw: string): DecisionTrigger[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (t): t is DecisionTrigger =>
      isRecord(t) && typeof t.kind === "string" && TRIGGER_KINDS.has(t.kind)
  )
}

function parseStall(raw: string | null): EventState["stall"] {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { pointId, sinceMs, fingerprint, escalated } = parsed
  if (
    typeof pointId !== "string" ||
    typeof sinceMs !== "number" ||
    typeof fingerprint !== "string" ||
    typeof escalated !== "boolean"
  ) {
    return null
  }
  return { pointId, sinceMs, fingerprint, escalated }
}

export type DecisionPointEngineDeps = {
  db: Database
  clock: Clock
  /** Service-clock ISO stamp (monotonic; same source as other payloads). */
  now(): string
  /** Direct runtime send into the scheduler's session (steer/fresh turn/
   * cold resume — the engine never touches the channel ledger). */
  send(agentId: string, text: string): Promise<SendOutcome>
  /** The fleet digest + a wall-clock-independent state fingerprint, computed
   * together against current DB state (moved here from the delivery face). */
  digestOf(eventId: string): { digest: string; fingerprint: string }
  /** W3 gate: a disabled scheduler receives nothing. */
  isSchedulerPaused(eventId: string): boolean
  /** The escalation's user-facing alarm (the urgent orch notice — the
   * unattended appliance's pager) for both escalation kinds. */
  escalateNotice(eventId: string, escalation: DecisionEscalation): void
  timings?: Partial<DecisionTimings>
}

export function createDecisionPointEngine(deps: DecisionPointEngineDeps) {
  const { db, clock } = deps
  const timings: DecisionTimings = { ...DEFAULT_TIMINGS, ...deps.timings }
  const effects = createEffects(clock)
  let closed = false

  const states = new Map<string, EventState>()
  const stateOf = (eventId: string): EventState => {
    let state = states.get(eventId)
    if (!state) {
      state = {
        pending: [],
        open: null,
        violations: 0,
        quietFingerprint: null,
        stall: null,
      }
      states.set(eventId, state)
    }
    return state
  }

  /** Accepted submit_plan registrations, keyed by SCHEDULER AGENT id (each
   * event has exactly one scheduler, so the key is collision-free across
   * events; a second registration for the same agent overwrites the first —
   * consumption only needs to know a plan landed in the settling turn).
   * Cleared on consumption, on discard, and whenever the scheduler lands
   * terminal (its next runtime restarts generations at 1 — a surviving
   * registration could otherwise falsely match). */
  const registrations = new Map<
    string,
    {
      turnGeneration: number
      allNoOp: boolean
    }
  >()

  function agentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).get()
  }

  function schedulerRow(eventId: string) {
    return db
      .select()
      .from(agents)
      .where(and(eq(agents.eventId, eventId), eq(agents.role, "orchestrator")))
      .get()
  }

  /** The engine's event gate — the ONE pause gate (§3.7): a paused event
   * queue or a disabled scheduler (W3) produces no decision points and no
   * violation escalation. */
  function gated(eventId: string): boolean {
    if (deps.isSchedulerPaused(eventId)) return true
    const row = db
      .select({ status: queueState.status })
      .from(queueState)
      .where(eq(queueState.eventId, eventId))
      .get()
    return row?.status === "paused"
  }

  // --- trigger intake ---------------------------------------------------------

  /** Record a trigger. The fact is the durable pending push — the projector
   * appends it to decision_state.pending in the append transaction — and
   * memory follows it. Urgent ones flush at once; the rest wait for the
   * coalescing window so a burst (a solve's cleanup cascade) lands as one
   * decision point. Gated drops emit NOTHING (unchanged semantics). */
  function trigger(eventId: string, t: DecisionTrigger): void {
    if (closed || gated(eventId)) return
    emitDomainEvent(db, {
      type: "decision_point.triggered",
      eventId,
      actor: { kind: "system", actorId: "decision-engine" },
      payload: t,
    })
    stateOf(eventId).pending.push(t)
    if (isUrgentTrigger(t)) drive(eventId)
    else scheduleFlush(eventId)
  }

  function scheduleFlush(eventId: string): void {
    if (closed) return
    effects.debounce(`dp:${eventId}`, timings.coalesceMs, () => drive(eventId))
  }

  // --- driving ------------------------------------------------------------------

  /** Serialize per event: one decision point at a time. */
  function drive(eventId: string): void {
    if (closed) return
    effects.chain(`dp-drive:${eventId}`, () => driveAwaited(eventId))
  }

  async function driveAwaited(eventId: string): Promise<void> {
    if (closed) return
    const state = stateOf(eventId)
    if (state.open || state.pending.length === 0) return
    if (gated(eventId)) {
      dropPending(eventId, "gated")
      return
    }
    const sched = schedulerRow(eventId)
    if (!sched) {
      // No scheduler to decide — the triggers have no consumer.
      dropPending(eventId, "no_scheduler")
      return
    }
    if (sched.status === "running") return // mid-turn: wait for its settle
    const canRevive = state.pending.some(
      (t) => t.kind === "user.directive" && t.revive === true
    )
    // A live scheduler is idle here (running returned above). A terminal one
    // is driven only by a user-initiated revive (startScheduler reopen) —
    // the cold resume rides the runtime send.
    if (sched.status !== "idle" && !canRevive) return
    const triggers = state.pending
    state.pending = []
    const { digest } = deps.digestOf(eventId)
    const id = crypto.randomUUID()
    state.open = {
      id,
      triggers,
      phase: "turn",
      errorRetries: 0,
      awaiting: true,
      digest,
    }
    emitDomainEvent(db, {
      type: "decision_point.opened",
      eventId,
      agentId: sched.id,
      actor: { kind: "system", actorId: "decision-engine" },
      payload: { id, triggers: triggers.map(triggerLine), at: deps.now() },
    })
    logEvent("scheduler", "decision_point_opened", {
      eventId,
      id: id.slice(0, 8),
      triggers: triggers.map((t) => t.kind),
    })
    await sendPayload(eventId, payloadMessage(id, triggers, digest))
  }

  /** Clear the pending set with its fact (C 批): the two driveAwaited drop
   * paths are observable — a gated drop and a no-scheduler drop are
   * different stories in the decision log. */
  function dropPending(
    eventId: string,
    reason: "gated" | "no_scheduler"
  ): void {
    const state = stateOf(eventId)
    const count = state.pending.length
    emitDomainEvent(db, {
      type: "decision_point.flushed",
      eventId,
      actor: { kind: "system", actorId: "decision-engine" },
      payload: { reason, count, at: deps.now() },
    })
    state.pending = []
  }

  /** Inject the payload into the scheduler's session. A failed/undelivered
   * send takes the error path (the turn can never settle). */
  async function sendPayload(eventId: string, text: string): Promise<void> {
    const open = stateOf(eventId).open
    if (!open) return
    const sched = schedulerRow(eventId)
    if (!sched) {
      closeDecisionPoint(eventId, "error")
      return
    }
    try {
      const outcome = await deps.send(sched.id, text)
      if (!outcome.delivered) handleError(eventId)
    } catch (error) {
      console.error("decision point payload send failed", {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      })
      closeDecisionPoint(eventId, "error")
    }
  }

  // --- turn-settle correlation ----------------------------------------------------

  /** From the status core, for EVERY agent turn settle (the settling turn's
   * generation rides along). Solvers feed the `agent.settled` trigger; the
   * scheduler's own settle either consumes a plan registration or (a
   * user-driven turn) re-drives pending ones. */
  function onTurnSettled(
    agentId: string,
    error: string | null,
    turnGeneration: number
  ): void {
    if (closed) return
    const row = agentRow(agentId)
    if (!row) return
    if (row.role !== "orchestrator") {
      trigger(row.eventId, {
        kind: "agent.settled",
        agentId,
        status: row.status,
      })
      return
    }
    const state = stateOf(row.eventId)
    const open = state.open
    if (!open || !open.awaiting) {
      // Not our turn (user message, boot) — pending triggers may proceed now.
      if (state.pending.length > 0) scheduleFlush(row.eventId)
      return
    }
    open.awaiting = false
    if (error) {
      // Provider failure: NOT a violation — the same point re-issues with a
      // fresh generation, so any plan registered inside the failed turn
      // mismatches and is discarded there (the re-issue path is byte-
      // identical to the pre-tool behavior, even when a plan applied).
      handleError(row.eventId)
      return
    }
    consumePlan(row.eventId, agentId, turnGeneration)
  }

  /** A scheduler agent landed terminal: a decision point that was driving it
   * closes as error WITHOUT retry (a retry would cold-revive an agent the
   * user just closed). Its plan registration dies too — a revived scheduler
   * restarts generations at 1 and could otherwise inherit the old turn's
   * plan. Solver terminals feed the agent.settled trigger. */
  function onAgentTerminal(agentId: string): void {
    if (closed) return
    const row = agentRow(agentId)
    if (!row) return
    if (row.role === "orchestrator") {
      registrations.delete(agentId)
      if (stateOf(row.eventId).open) closeDecisionPoint(row.eventId, "error")
      return
    }
    trigger(row.eventId, {
      kind: "agent.settled",
      agentId,
      status: row.status,
    })
  }

  /** Consume the settling turn's plan registration (B 批 — replaces the
   * plan.proposed time-window scan). A registration whose generation does
   * not match the settling turn (stale, from an errored retry, or absent —
   * e.g. an HTTP-endpoint submission, which never registers) is discarded
   * and the violation ladder proceeds exactly as before. */
  function consumePlan(
    eventId: string,
    schedulerId: string,
    turnGeneration: number
  ): void {
    const state = stateOf(eventId)
    const open = state.open
    if (!open) return
    // The user paused (halt) while the turn was in flight: the ladder stops
    // here — no re-prompt, no violation counting, the gate owns the rest.
    if (gated(eventId)) {
      registrations.delete(schedulerId)
      closeDecisionPoint(eventId, "error")
      flushPending(eventId)
      return
    }
    const sched = schedulerRow(eventId)
    if (!sched) {
      registrations.delete(schedulerId)
      closeDecisionPoint(eventId, "error")
      return
    }
    const registration = registrations.get(schedulerId)
    registrations.delete(schedulerId)
    if (!registration || registration.turnGeneration !== turnGeneration) {
      violationLadder(eventId, sched)
      return
    }
    // An accepted plan closes the point. An all-noOp plan is an explicit
    // no-decision — it records the quiet fingerprint for the periodic skip
    // and arms the stall episode (§3.7 r1); a real plan clears both. The
    // close carries the arming data in its payload (the projector writes
    // decision_state from it); memory mirrors the projection after the fact.
    const { fingerprint } = deps.digestOf(eventId)
    const sinceMs = clock.now()
    closeDecisionPoint(
      eventId,
      "plan",
      registration.allNoOp
        ? {
            allNoOp: true,
            quietFingerprint: fingerprint,
            stallSinceMs: sinceMs,
          }
        : undefined
    )
    state.quietFingerprint = registration.allNoOp ? fingerprint : null
    state.stall = registration.allNoOp
      ? {
          pointId: open.id,
          sinceMs,
          fingerprint,
          escalated: false,
        }
      : null
    state.violations = 0
    flushPending(eventId)
  }

  /** The violation ladder (§3.6 rule 3), entered on a clean settle without a
   * matching plan registration. The stall episode stays armed: a noOp
   * followed by persistent non-deciding on an unchanged situation is exactly
   * what it escalates. */
  function violationLadder(
    eventId: string,
    sched: NonNullable<ReturnType<typeof schedulerRow>>
  ): void {
    const state = stateOf(eventId)
    const open = state.open
    if (!open) return
    if (open.phase !== "reprompt") {
      open.phase = "reprompt"
      open.awaiting = true
      emitDomainEvent(db, {
        type: "decision_point.reprompted",
        eventId,
        agentId: sched.id,
        actor: { kind: "system", actorId: "decision-engine" },
        payload: { id: open.id, at: deps.now() },
      })
      void sendReprompt(eventId, sched.id, open.id)
      return
    }
    closeDecisionPoint(eventId, "violation")
    state.violations += 1
    if (state.violations >= timings.violationsToEscalate) {
      state.violations = 0
      escalate(eventId, {
        reason: "scheduler_violation",
        decisionPointId: open.id.slice(0, 8),
        consecutive: timings.violationsToEscalate,
      })
    }
    flushPending(eventId)
  }

  async function sendReprompt(
    eventId: string,
    schedulerId: string,
    pointId: string
  ): Promise<void> {
    if (closed || gated(eventId)) {
      closeDecisionPoint(eventId, "error")
      return
    }
    try {
      const outcome = await deps.send(schedulerId, repromptMessage(pointId))
      if (!outcome.delivered) handleError(eventId)
    } catch (error) {
      console.error("decision point re-prompt failed", {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      })
      closeDecisionPoint(eventId, "error")
    }
  }

  /** The turn errored (provider failure, dead session): NOT a violation —
   * re-issue the same decision point after a bounded backoff, give up as
   * outcome=error after the bound. */
  function handleError(eventId: string): void {
    const open = stateOf(eventId).open
    if (!open) return
    if (open.errorRetries < timings.maxErrorRetries) {
      open.errorRetries += 1
      if (closed) return
      effects.retry(`dp-retry:${eventId}`, timings.errorRetryMs, () =>
        redrive(eventId)
      )
      return
    }
    closeDecisionPoint(eventId, "error")
    flushPending(eventId)
  }

  /** Re-issue the SAME decision point (same id, same triggers) — the payload
   * is re-rendered so the digest reflects current state. */
  function redrive(eventId: string): void {
    effects.chain(`dp-drive:${eventId}`, async () => {
      if (closed) return
      const state = stateOf(eventId)
      const open = state.open
      if (!open || open.awaiting) return
      if (gated(eventId)) {
        closeDecisionPoint(eventId, "error")
        return
      }
      const sched = schedulerRow(eventId)
      if (!sched || sched.status !== "idle") {
        // The scheduler vanished or is mid-turn: the point cannot re-issue.
        closeDecisionPoint(eventId, "error")
        return
      }
      open.awaiting = true
      const { digest } = deps.digestOf(eventId)
      open.digest = digest
      await sendPayload(eventId, payloadMessage(open.id, open.triggers, digest))
    })
  }

  // --- lifecycle -----------------------------------------------------------------

  /** Close the open point with its fact: the closed event (and the projection
   * it drives) lands first, then memory drops the point. `extra` carries the
   * additive C-批 payload facts — an all-noOp plan close's fingerprint/stall
   * arming, or the hydration close's `reason: "boot"`. */
  function closeDecisionPoint(
    eventId: string,
    outcome: "plan" | "violation" | "error",
    extra?: {
      allNoOp?: boolean
      quietFingerprint?: string
      stallSinceMs?: number
      reason?: string
    }
  ): void {
    const state = stateOf(eventId)
    const open = state.open
    if (!open) return
    emitDomainEvent(db, {
      type: "decision_point.closed",
      eventId,
      actor: { kind: "system", actorId: "decision-engine" },
      payload: { id: open.id, outcome, at: deps.now(), ...extra },
    })
    state.open = null
    if (outcome !== "plan") state.quietFingerprint = null
    logEvent("scheduler", "decision_point_closed", {
      eventId,
      id: open.id.slice(0, 8),
      outcome,
    })
  }

  /** After a close, remaining triggers open the next decision point. */
  function flushPending(eventId: string): void {
    const state = stateOf(eventId)
    if (state.open || state.pending.length === 0 || closed) return
    if (state.pending.some(isUrgentTrigger)) drive(eventId)
    else scheduleFlush(eventId)
  }

  /** The shared alarm face: a watchdog.escalated fact + the urgent orch
   * notice through the dep (the violation ladder's bound and the stall
   * episode both land here). */
  function escalate(eventId: string, escalation: DecisionEscalation): void {
    emitDomainEvent(db, {
      type: "watchdog.escalated",
      eventId,
      agentId: schedulerRow(eventId)?.id ?? null,
      actor: { kind: "system", actorId: "decision-engine" },
      payload: {
        reason: escalation.reason,
        detail: escalation,
        at: deps.now(),
      },
    })
    deps.escalateNotice(eventId, escalation)
    logEvent("scheduler", "escalated", { eventId, ...escalation })
  }

  // --- periodic re-examination (the old heartbeat's replacement) -------------------

  function periodicTick(): void {
    if (closed) return
    const rows = db
      .select({ eventId: agents.eventId })
      .from(agents)
      .where(and(eq(agents.role, "orchestrator"), eq(agents.status, "idle")))
      .all()
    for (const { eventId } of rows) {
      if (gated(eventId)) continue
      const { fingerprint } = deps.digestOf(eventId)
      const state = stateOf(eventId)
      // Stall contraction (§3.7 r1): an all-noOp close armed an episode; a
      // real plan disarms it and a moved situation cancels it (the periodic
      // point below then re-judges). Only an unchanged situation persisting
      // ≥ stallMs escalates — once per episode.
      const stall = state.stall
      if (stall) {
        if (stall.fingerprint !== fingerprint) {
          // The situation moved — the episode cancels (fact first, then
          // memory) and the periodic point below re-judges it.
          emitDomainEvent(db, {
            type: "decision_point.stall_cleared",
            eventId,
            actor: { kind: "system", actorId: "decision-engine" },
            payload: { pointId: stall.pointId, at: deps.now() },
          })
          state.stall = null
        } else if (
          !stall.escalated &&
          clock.now() - stall.sinceMs >= timings.stallMs
        ) {
          stall.escalated = true
          escalate(eventId, {
            reason: "scheduler_stalled",
            decisionPointId: stall.pointId.slice(0, 8),
            stalledMs: clock.now() - stall.sinceMs,
          })
        }
      }
      // Skip the tick when the fleet is fingerprint-identical to the last
      // explicit no-decision — a quiet event burns no heartbeat turn (§3.6 r4).
      if (
        state.quietFingerprint !== null &&
        state.quietFingerprint === fingerprint
      ) {
        continue
      }
      trigger(eventId, { kind: "periodic" })
    }
  }

  effects.every(timings.periodicMs, periodicTick)

  // --- boot ----------------------------------------------------------------------

  /** Events whose hydrated state carried unfinished business (an orphan open
   * point or non-empty pending) — the narrowed boot.resync's case (a). */
  const bootUnfinished = new Set<string>()

  function hydrate(): void {
    const rows = db.select().from(decisionState).all()
    for (const row of rows) {
      const pending = parseTriggers(row.pending)
      const state: EventState = {
        pending,
        open: null,
        violations: row.violations,
        quietFingerprint: row.quietFingerprint,
        stall: parseStall(row.stall),
      }
      states.set(row.eventId, state)
      if (row.openPointId) {
        // Orphan open point: the restart interrupted its drive. Close it
        // error/reason=boot so the decision log never shows an eternal open
        // point — the error close clears the quiet fingerprint on both sides
        // (projection + memory) while the stall episode and violation count
        // survive like any error close.
        bootUnfinished.add(row.eventId)
        emitDomainEvent(db, {
          type: "decision_point.closed",
          eventId: row.eventId,
          actor: { kind: "system", actorId: "decision-engine" },
          payload: {
            id: row.openPointId,
            outcome: "error",
            reason: "boot",
            at: deps.now(),
          },
        })
        state.quietFingerprint = null
      }
      if (pending.length > 0) {
        // Un-flushed triggers re-drive through the normal coalescing window.
        bootUnfinished.add(row.eventId)
        scheduleFlush(row.eventId)
      }
    }
  }

  hydrate()

  /** `recoverOnBoot`'s re-entry, narrowed (C 批 §4.3): a boot.resync decision
   * point fires only where the restart left the scheduler a reason to
   * re-sync — (a) the hydration found unfinished business for the event
   * (orphan open point / non-empty pending), or (b) `interrupted` lists the
   * events whose scheduler was RUNNING before the restart (kernel flips them
   * via agent.recovered; the interrupted turn's cold-resumed session needs a
   * fresh synchronization). A quiet idle event restarts at zero LLM cost. */
  function bootResync(interrupted: readonly string[]): void {
    if (closed) return
    const events = new Set<string>(bootUnfinished)
    for (const eventId of interrupted) events.add(eventId)
    for (const eventId of events) {
      trigger(eventId, { kind: "boot.resync" })
    }
  }

  /** Drop one event's state (event deletion): the in-memory working copy AND
   * its decision_state row — a direct constrained teardown, same category as
   * the deletion paths' channels/workspace sweeps (the projector owns only
   * the fact-driven writes, never deletes). */
  function forget(eventId: string): void {
    states.delete(eventId)
    bootUnfinished.delete(eventId)
    db.delete(decisionState).where(eq(decisionState.eventId, eventId)).run()
  }

  function close(): void {
    closed = true
    effects.dispose()
    states.clear()
  }

  return {
    trigger,
    /** The submit_plan tool handler's registration hop (B 批): a plan whose
     * proposal landed in-turn is REGISTERED here; consumption happens at the
     * turn's clean settle with a matching generation (see onTurnSettled). A
     * turn submitting multiple plans: the last registration wins (closes the
     * point; allNoOp taken from the last). */
    registerPlan(registration: {
      schedulerAgentId: string
      turnGeneration: number
      allNoOp: boolean
    }): void {
      if (closed) return
      registrations.set(registration.schedulerAgentId, {
        turnGeneration: registration.turnGeneration,
        allNoOp: registration.allNoOp,
      })
    },
    onTurnSettled,
    onAgentTerminal,
    bootResync,
    forget,
    close,
  }
}

// --- payload rendering -----------------------------------------------------------

/** The ONE payload message injected per decision point: trigger facts + the
 * fleet digest + the turn protocol demand. Not a channel row — the scheduler's
 * session is the only destination. */
function payloadMessage(
  id: string,
  triggers: DecisionTrigger[],
  digest: string
): string {
  const lines = triggers.map(triggerLine).map((line) => `- ${line}`)
  return (
    `[决策点 ${id.slice(0, 8)}]（引擎注入，非频道消息）\n` +
    `触发：\n${lines.join("\n")}\n` +
    (digest ? `\n${digest}\n` : "") +
    `\n回合协议：先处理触发事项——通信保持自由文本（aegisx.channels.post 回答/广播/私信 dm:<agentId>），` +
    `状态细节用 aegisx.snapshot() / aegisx.agents.read 现查；然后必须以 submit_plan 工具调用收束本回合，` +
    `确实无需行动时提交一个 noOp 动作。回合结束时仍未以 submit_plan 收束即属违约：会被重试一次并计入违约。`
  )
}

/** The ONE strict re-prompt of the violation ladder. */
function repromptMessage(pointId: string): string {
  return (
    `[决策点 ${pointId.slice(0, 8)}] 违约提醒：上一回合结束仍未收到计划。` +
    `立即以 submit_plan 工具调用收束（无需行动 = 提交一个 noOp 动作）——继续不交计划将升级告警。`
  )
}
