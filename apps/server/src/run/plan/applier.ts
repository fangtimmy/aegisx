import type {
  Plan,
  PlanAction,
  PlanActionKind,
  PlanErrorCode,
  PlanRefResult,
  SubmitPlanResult,
} from "@aegisx/shared"
import { isRecord, isTerminalAgentStatus } from "@aegisx/shared"
import { and, eq } from "drizzle-orm"

import type { Database } from "../../db"
import { agents, challenges, planRefs, spawnQueue } from "../../db/schema"
import type { Principal } from "../../infrastructure/agent-auth"
import { parseJson } from "../../lib/guards"
import { fullySolved } from "../../platforms/challenge-state"
import type { Clock } from "../clock"
import { actorFromPrincipal, emitDomainEvent } from "../domain-events/store"
import { createEffects } from "../effects"
import { RunActionError } from "../errors"
import type { ModelResolver } from "../model-resolver"
import { assertMayTouchEvent } from "../principal-scope"
import type { QueueService } from "../queue"
import { schedulerPolicyFor } from "../scheduler-policy"
import { canonicalActionOf } from "./schema"

export type PlanApplierDeps = {
  db: Database
  /** Time layer for the per-event application chain (fake-clock injectable). */
  clock: Clock
  modelResolver: ModelResolver
  queue: QueueService
  /** Plan-path stop with a BOUNDED abort wait (today's stopAgent awaits
   * session.abort() unbounded); expiry force-disposes via the standard settle
   * path — the close semantics. Owned by the service (needs the runtime
   * registry). */
  stopAgentBounded(agentId: string, principal: Principal): Promise<void>
  closeAgent(agentId: string, principal: Principal): Promise<unknown>
  finishAgent(
    agentId: string,
    summary: string,
    actor: "user" | "scheduler",
    principal: Principal
  ): Promise<unknown>
  sendMessage(
    agentId: string,
    input: { text: string },
    principal: Principal
  ): Promise<unknown>
  setAgentTimeout(
    agentId: string,
    timeoutMs: number,
    principal: Principal
  ): unknown
  now(): string
}

/** Validation verdict per action: where it applies (fast inline / slow on the
 * deferred chain) or why it rejects. */
type ActionVerdict =
  | { phase: "fast" | "slow" }
  | {
      code: PlanErrorCode
      message: string
    }

type ActionError = { code: PlanErrorCode; message: string }

function failureCode(error: unknown): PlanErrorCode {
  return error instanceof RunActionError && error.code === "not_found"
    ? "unknown_agent"
    : "wrong_state"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertNever(_action: never): never {
  throw new Error(`unreachable plan action kind`)
}

/** Plan-level envelope problems (the endpoint's schema is the first gate;
 * this is the in-process safety net). */
function envelopeProblem(plan: Plan): ActionError | null {
  if (
    !isRecord(plan) ||
    typeof plan.rationale !== "string" ||
    !plan.rationale.trim()
  ) {
    return { code: "schema", message: "plan requires a non-empty rationale" }
  }
  if (!Array.isArray(plan.actions)) {
    return { code: "schema", message: "plan.actions must be an array" }
  }
  if (plan.actions.length === 0) {
    return {
      code: "empty_plan",
      message:
        "plan has no actions — declare a deliberate pass with an explicit noOp action",
    }
  }
  for (const action of plan.actions) {
    if (!isRecord(action) || typeof action.ref !== "string" || !action.ref) {
      return {
        code: "schema",
        message: "every action requires a non-empty ref",
      }
    }
  }
  return null
}

/**
 * The plan applier (control-plane design §B): the scheduler submits a typed
 * plan; validation is synchronous and pure — ANY per-ref error rejects the
 * WHOLE plan (nothing applied, no proposal — same-turn repair means the model
 * resubmits). Only a fully-valid plan is proposed (plan.proposed), then the
 * fast actions apply inline and the slow ones (stop/close/finish/cold wakes)
 * ride the per-event serial application chain, each re-validating its target
 * at application time; plan.result lands when that chain completes.
 *
 * Idempotency: the (schedulerAgentId, ref) key resolves against the plan_refs
 * projection — same ref + identical action returns the original outcome
 * without re-applying; same ref + different content is a duplicate_ref
 * rejection.
 */
export function createPlanApplier(deps: PlanApplierDeps) {
  const { db } = deps
  const effects = createEffects(deps.clock)

  const agentRow = (agentId: string) =>
    db.select().from(agents).where(eq(agents.id, agentId)).get()

  /** The scheduler's recorded ref history on this event, read from the
   * plan_refs projection (B 批 — replaces the full plan.proposed/plan.result
   * event scan): ref → the action as first proposed, plus its outcome once
   * plan.result landed (null while the application chain is still running). */
  function proposedHistory(
    eventId: string,
    schedulerKey: string
  ): Map<
    string,
    { canonical: string; planId: string; outcome: PlanRefResult | null }
  > {
    const byRef = new Map<
      string,
      { canonical: string; planId: string; outcome: PlanRefResult | null }
    >()
    for (const row of db
      .select()
      .from(planRefs)
      .where(
        and(
          eq(planRefs.eventId, eventId),
          eq(planRefs.schedulerAgentId, schedulerKey)
        )
      )
      .all()) {
      byRef.set(row.ref, {
        canonical: row.canonical,
        planId: row.planId,
        outcome: row.outcome ? parseJson<PlanRefResult>(row.outcome) : null,
      })
    }
    return byRef
  }

  function agentOnEvent(
    agentId: string,
    eventId: string
  ): { row: typeof agents.$inferSelect } | ActionError {
    const row = agentRow(agentId)
    if (!row || row.eventId !== eventId) {
      return {
        code: "unknown_agent",
        message: `Agent "${agentId}" not found on this event`,
      }
    }
    return { row }
  }

  function validateAction(
    action: PlanAction,
    eventId: string,
    schedulerKey: string
  ): ActionVerdict {
    switch (action.kind) {
      case "enqueue": {
        const challenge = db
          .select({ eventId: challenges.eventId })
          .from(challenges)
          .where(eq(challenges.id, action.challengeId))
          .get()
        if (!challenge || challenge.eventId !== eventId) {
          return {
            code: "unknown_challenge",
            message: `Challenge "${action.challengeId}" does not belong to this event`,
          }
        }
        if (
          action.model !== undefined &&
          !deps.modelResolver.resolveModelTarget(action.model)
        ) {
          return {
            code: "model_unresolvable",
            message: `Model "${action.model}" is not available`,
          }
        }
        // The submit-time half of the fence (capacity stays the drainer's
        // launch-time business): the same policy + solved verdict it uses.
        if (
          schedulerPolicyFor(db, eventId).blockSpawnOnSolved &&
          fullySolved(db, action.challengeId)
        ) {
          return {
            code: "solved_blocked",
            message:
              "Challenge is fully solved — this event's policy blocks new spawns on it",
          }
        }
        return { phase: "fast" }
      }
      case "message": {
        const verdict = agentOnEvent(action.agentId, eventId)
        if ("code" in verdict) return verdict
        // Fast when the target is alive (steer / fresh turn); a terminal
        // target is a cold wake — slow phase.
        return isTerminalAgentStatus(verdict.row.status)
          ? { phase: "slow" }
          : { phase: "fast" }
      }
      case "stop":
      case "close": {
        if (action.agentId === schedulerKey) {
          return {
            code: "self_target",
            message:
              "the scheduler's own lifecycle goes through the engine/user paths, not the plan",
          }
        }
        const verdict = agentOnEvent(action.agentId, eventId)
        if ("code" in verdict) return verdict
        if (isTerminalAgentStatus(verdict.row.status)) {
          return {
            code: "wrong_state",
            message: `Agent "${action.agentId}" is already terminal`,
          }
        }
        return { phase: "slow" }
      }
      case "finish": {
        if (action.agentId === schedulerKey) {
          return {
            code: "self_target",
            message:
              "the scheduler's own lifecycle goes through the engine/user paths, not the plan",
          }
        }
        const verdict = agentOnEvent(action.agentId, eventId)
        if ("code" in verdict) return verdict
        if (verdict.row.status === "completed") return { phase: "fast" }
        if (isTerminalAgentStatus(verdict.row.status)) {
          return {
            code: "wrong_state",
            message: `Agent "${action.agentId}" is already closed`,
          }
        }
        return { phase: "slow" }
      }
      case "setDeadline": {
        const verdict = agentOnEvent(action.agentId, eventId)
        if ("code" in verdict) return verdict
        if (!(action.timeoutMs > 0)) {
          return { code: "schema", message: "timeoutMs must be positive" }
        }
        return { phase: "fast" }
      }
      case "cancelItem": {
        const row = db
          .select({ eventId: spawnQueue.eventId, status: spawnQueue.status })
          .from(spawnQueue)
          .where(eq(spawnQueue.id, action.itemId))
          .get()
        if (!row || row.eventId !== eventId) {
          return {
            code: "wrong_state",
            message: `Queue item "${action.itemId}" not found on this event`,
          }
        }
        if (row.status !== "pending") {
          return {
            code: "wrong_state",
            message: `Queue item "${action.itemId}" is ${row.status}, not pending`,
          }
        }
        return { phase: "fast" }
      }
      case "reorder": {
        for (const itemId of action.itemIds) {
          const row = db
            .select({ eventId: spawnQueue.eventId })
            .from(spawnQueue)
            .where(eq(spawnQueue.id, itemId))
            .get()
          if (!row || row.eventId !== eventId) {
            return {
              code: "wrong_state",
              message: `Queue item "${itemId}" not found on this event`,
            }
          }
        }
        return { phase: "fast" }
      }
      case "setQueuePaused":
        return { phase: "fast" }
      case "noOp":
        if (!action.reason.trim()) {
          return { code: "schema", message: "noOp requires a reason" }
        }
        return { phase: "fast" }
      default:
        return assertNever(action)
    }
  }

  async function submitPlan(
    eventId: string,
    plan: Plan,
    principal: Principal
  ): Promise<SubmitPlanResult> {
    assertMayTouchEvent(principal, eventId)
    const schedulerKey =
      principal.kind === "agent"
        ? principal.agentId
        : principal.kind === "system"
          ? "system"
          : "user"
    const finishActor = () =>
      principal.kind === "agent" ? ("scheduler" as const) : ("user" as const)
    const queueAfter = () => deps.queue.list(eventId, principal)

    const envelope = envelopeProblem(plan)
    if (envelope) {
      return {
        results: [{ ref: "", kind: "noOp", ok: false, ...envelope }],
        queueAfter: queueAfter(),
        deferred: [],
      }
    }

    // --- dedup: (schedulerKey, ref) against the proposal history -----------
    const history = proposedHistory(eventId, schedulerKey)
    const seen = new Set<string>()
    const idempotent = new Map<string, PlanRefResult>()
    const errors = new Map<string, ActionError>()
    for (const action of plan.actions) {
      if (seen.has(action.ref)) {
        errors.set(action.ref, {
          code: "duplicate_ref",
          message: `ref "${action.ref}" appears twice in this plan`,
        })
        continue
      }
      seen.add(action.ref)
      const prior = history.get(action.ref)
      if (!prior) continue
      if (prior.canonical === canonicalActionOf(action)) {
        idempotent.set(
          action.ref,
          prior.outcome ?? {
            ref: action.ref,
            kind: action.kind,
            ok: true,
            message: `idempotent replay — ref "${action.ref}" was proposed in plan ${prior.planId} and its outcome is still pending`,
          }
        )
      } else {
        errors.set(action.ref, {
          code: "duplicate_ref",
          message: `ref "${action.ref}" was already used with different content (plan ${prior.planId})`,
        })
      }
    }

    // --- synchronous validation: any error rejects the WHOLE plan ----------
    const phases = new Map<string, "fast" | "slow">()
    for (const action of plan.actions) {
      if (errors.has(action.ref) || idempotent.has(action.ref)) continue
      const verdict = validateAction(action, eventId, schedulerKey)
      if ("code" in verdict) {
        errors.set(action.ref, verdict)
        continue
      }
      phases.set(action.ref, verdict.phase)
    }
    if (errors.size > 0) {
      return {
        results: plan.actions.map((action) => {
          const error = errors.get(action.ref)
          if (error) {
            return { ref: action.ref, kind: action.kind, ok: false, ...error }
          }
          const replayed = idempotent.get(action.ref)
          if (replayed) return replayed
          return {
            ref: action.ref,
            kind: action.kind,
            ok: false,
            message: "plan rejected — fix the failing refs and resubmit",
          }
        }),
        queueAfter: queueAfter(),
        deferred: [],
      }
    }

    // A full idempotent replay changes nothing — return the original outcomes
    // without re-proposing.
    if (plan.actions.every((action) => idempotent.has(action.ref))) {
      return {
        results: plan.actions.map((action) => idempotent.get(action.ref)!),
        queueAfter: queueAfter(),
        deferred: [],
      }
    }

    // --- propose ------------------------------------------------------------
    const planId = crypto.randomUUID()
    const agentColumn = principal.kind === "agent" ? principal.agentId : null
    const { id: proposedEventId } = emitDomainEvent(db, {
      type: "plan.proposed",
      eventId,
      agentId: agentColumn,
      actor: actorFromPrincipal(principal),
      payload: {
        planId,
        rationale: plan.rationale,
        actions: plan.actions,
        schedulerAgentId: schedulerKey,
        at: deps.now(),
      },
    })

    const results: PlanRefResult[] = []
    const deferred: Array<{
      ref: string
      kind: PlanActionKind
      action: PlanAction
    }> = []

    async function applyFast(action: PlanAction): Promise<PlanRefResult> {
      const base = { ref: action.ref, kind: action.kind }
      try {
        switch (action.kind) {
          case "enqueue": {
            const item = deps.queue.enqueue(
              {
                eventId,
                challengeId: action.challengeId,
                ...(action.prompt !== undefined
                  ? { prompt: action.prompt }
                  : {}),
                ...(action.model !== undefined ? { model: action.model } : {}),
                ...(action.timeoutMs !== undefined
                  ? { timeoutMs: action.timeoutMs }
                  : {}),
                source: "scheduler",
                planId,
              },
              principal
            )
            return { ...base, ok: true, itemId: item.id }
          }
          case "cancelItem": {
            deps.queue.cancelItem(eventId, action.itemId, principal)
            return { ...base, ok: true, itemId: action.itemId }
          }
          case "reorder": {
            deps.queue.reorder(eventId, action.itemIds, principal)
            return { ...base, ok: true }
          }
          case "setDeadline": {
            deps.setAgentTimeout(action.agentId, action.timeoutMs, principal)
            return { ...base, ok: true, agentId: action.agentId }
          }
          case "setQueuePaused": {
            if (action.paused) {
              // The pause carries the plan's id (§3.8 provenance labeling):
              // a scheduler that pauses and then dies leaves an auditable
              // source instead of a stuck anonymous gate.
              deps.queue.pause(eventId, "scheduler", principal, planId)
            } else {
              deps.queue.resume(eventId, "scheduler", principal)
              deps.queue.scheduleDrain()
            }
            return { ...base, ok: true }
          }
          case "message": {
            await deps.sendMessage(
              action.agentId,
              { text: action.text },
              principal
            )
            return { ...base, ok: true, agentId: action.agentId }
          }
          case "finish": {
            // Fast only when already completed — the idempotent no-op path.
            await deps.finishAgent(
              action.agentId,
              action.summary,
              finishActor(),
              principal
            )
            return { ...base, ok: true, agentId: action.agentId }
          }
          case "noOp":
            return { ...base, ok: true }
          default:
            // stop/close are slow-phase actions — the inline phase never
            // reaches them (phases come from validateAction).
            return {
              ...base,
              ok: false,
              code: "wrong_state",
              message: `action "${action.kind}" cannot apply in the fast phase`,
            }
        }
      } catch (error) {
        return {
          ...base,
          ok: false,
          code: failureCode(error),
          message: errorMessage(error),
        }
      }
    }

    async function applySlow(action: PlanAction): Promise<PlanRefResult> {
      const base = { ref: action.ref, kind: action.kind }
      try {
        switch (action.kind) {
          case "stop": {
            // Re-validate at application time: the target must still be live.
            const row = agentRow(action.agentId)
            if (!row || row.eventId !== eventId) {
              return {
                ...base,
                ok: false,
                code: "unknown_agent",
                message: `Agent "${action.agentId}" not found on this event`,
              }
            }
            if (isTerminalAgentStatus(row.status)) {
              return {
                ...base,
                ok: false,
                code: "wrong_state",
                message: `Agent "${action.agentId}" is already terminal`,
              }
            }
            await deps.stopAgentBounded(action.agentId, principal)
            return { ...base, ok: true, agentId: action.agentId }
          }
          case "close": {
            await deps.closeAgent(action.agentId, principal)
            return { ...base, ok: true, agentId: action.agentId }
          }
          case "finish": {
            await deps.finishAgent(
              action.agentId,
              action.summary,
              finishActor(),
              principal
            )
            return { ...base, ok: true, agentId: action.agentId }
          }
          case "message": {
            // Terminal target at classification time — cold wake (the send
            // rebuilds the session and drives a fresh turn).
            await deps.sendMessage(
              action.agentId,
              { text: action.text },
              principal
            )
            return { ...base, ok: true, agentId: action.agentId }
          }
          default:
            // Fast actions never reach the deferred chain.
            return {
              ...base,
              ok: false,
              code: "wrong_state",
              message: `action "${action.kind}" cannot apply in the slow phase`,
            }
        }
      } catch (error) {
        return {
          ...base,
          ok: false,
          code: failureCode(error),
          message: errorMessage(error),
        }
      }
    }

    function emitResult(): void {
      emitDomainEvent(db, {
        type: "plan.result",
        eventId,
        agentId: agentColumn,
        actor: { kind: "system", actorId: "plan-applier" },
        causationId: proposedEventId,
        payload: { planId, results, at: deps.now() },
      })
    }

    // --- apply: fast inline, slow deferred (listing order = apply order) ---
    for (const action of plan.actions) {
      const replayed = idempotent.get(action.ref)
      if (replayed) {
        results.push(replayed)
        continue
      }
      if (phases.get(action.ref) === "slow") {
        deferred.push({ ref: action.ref, kind: action.kind, action })
        results.push({
          ref: action.ref,
          kind: action.kind,
          ok: true,
          message: "deferred — the outcome lands in plan.result",
        })
        continue
      }
      results.push(await applyFast(action))
    }

    if (deferred.length > 0) {
      effects.chain(`plan:${eventId}`, async () => {
        for (const item of deferred) {
          const outcome = await applySlow(item.action)
          const index = results.findIndex((r) => r.ref === item.ref)
          if (index >= 0) results[index] = outcome
        }
        emitResult()
      })
    } else {
      emitResult()
    }

    return {
      planId,
      results,
      queueAfter: queueAfter(),
      deferred: deferred.map(({ ref, kind }) => ({ ref, kind })),
    }
  }

  return {
    submitPlan,
    close: () => effects.dispose(),
  }
}
