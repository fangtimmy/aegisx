import { LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../../db"
import { agents, queueState } from "../../db/schema"
import { logEvent } from "../../lib/log"
import { FLUSH_INTERVAL_MS } from "../channels-context"
import type { Clock } from "../clock"
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

  /** Record a trigger. Urgent ones flush at once; the rest wait for the
   * coalescing window so a burst (a solve's cleanup cascade) lands as one
   * decision point. */
  function trigger(eventId: string, t: DecisionTrigger): void {
    if (closed || gated(eventId)) return
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
      state.pending = []
      return
    }
    const sched = schedulerRow(eventId)
    if (!sched) {
      // No scheduler to decide — the triggers have no consumer.
      state.pending = []
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
    // and arms the stall episode (§3.7 r1); a real plan clears both.
    const { fingerprint } = deps.digestOf(eventId)
    state.quietFingerprint = registration.allNoOp ? fingerprint : null
    state.stall = registration.allNoOp
      ? {
          pointId: open.id,
          sinceMs: clock.now(),
          fingerprint,
          escalated: false,
        }
      : null
    state.violations = 0
    closeDecisionPoint(eventId, "plan")
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

  function closeDecisionPoint(
    eventId: string,
    outcome: "plan" | "violation" | "error"
  ): void {
    const state = stateOf(eventId)
    const open = state.open
    if (!open) return
    state.open = null
    if (outcome !== "plan") state.quietFingerprint = null
    emitDomainEvent(db, {
      type: "decision_point.closed",
      eventId,
      actor: { kind: "system", actorId: "decision-engine" },
      payload: { id: open.id, outcome, at: deps.now() },
    })
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

  /** `recoverOnBoot`'s re-entry: every surviving live scheduler gets one
   * re-sync decision point (replaces run/boot-reentry). */
  function bootResync(): void {
    if (closed) return
    const rows = db
      .select({ eventId: agents.eventId })
      .from(agents)
      .where(
        and(
          eq(agents.role, "orchestrator"),
          inArray(agents.status, [...LIVE_AGENT_STATUSES])
        )
      )
      .all()
    for (const { eventId } of rows) {
      trigger(eventId, { kind: "boot.resync" })
    }
  }

  /** Drop one event's in-memory state (event deletion). */
  function forget(eventId: string): void {
    states.delete(eventId)
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
