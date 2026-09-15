/** Scheduler plan wire types (control-plane design §B). The scheduler's
 * output is a typed plan; the server's plan applier validates it, applies the
 * fast actions inline and defers the slow ones (POST /api/events/:eventId/plan
 * → SubmitPlanResult; deferred outcomes land in the plan.result decision-log
 * entry). */
import type { QueueItemPublic } from "./queue"

/** One plan action. Every variant carries `ref` — the scheduler's own short
 * id for per-ref result correlation, resubmission idempotency and
 * ref-scoped validation errors. */
export type PlanAction =
  | {
      ref: string
      kind: "enqueue"
      challengeId: string
      prompt?: string
      model?: string
      timeoutMs?: number
    }
  | {
      ref: string
      kind: "message"
      agentId: string
      text: string
      urgent?: boolean
    }
  | { ref: string; kind: "stop"; agentId: string }
  | { ref: string; kind: "close"; agentId: string }
  | { ref: string; kind: "finish"; agentId: string; summary: string }
  | { ref: string; kind: "setDeadline"; agentId: string; timeoutMs: number }
  | { ref: string; kind: "cancelItem"; itemId: string }
  | { ref: string; kind: "reorder"; itemIds: string[] }
  | { ref: string; kind: "setQueuePaused"; paused: boolean }
  | { ref: string; kind: "noOp"; reason: string }

export type PlanActionKind = PlanAction["kind"]

/** The plan document: a 1-3 sentence decision rationale (decision log only,
 * never executed) plus the actions in application order (listing order IS
 * application order — validation never reorders). */
export type Plan = { rationale: string; actions: PlanAction[] }

/** Per-ref validation error codes (plan outcomes, not HTTP errors — a
 * validation failure rejects the whole plan and comes back as per-ref
 * results for same-turn repair). */
export type PlanErrorCode =
  | "unknown_challenge"
  | "unknown_agent"
  | "wrong_state"
  | "duplicate_ref"
  | "empty_plan"
  | "model_unresolvable"
  | "solved_blocked"
  | "self_target"
  | "schema"

/** One action's outcome: applied / rejected(code, message) / deferred.
 * `agentId` / `itemId` back-fill the addressed resource where applicable. */
export type PlanRefResult = {
  ref: string
  kind: PlanActionKind
  ok: boolean
  code?: PlanErrorCode
  message?: string
  agentId?: string
  itemId?: string
}

/** POST /api/events/:eventId/plan — fast actions are already applied when
 * this returns; slow ones ride the per-event application chain and report
 * through plan.result. */
export type SubmitPlanResult = {
  /** The proposal's id — present when this call landed a new plan.proposed
   * (absent on pure idempotent replays and whole-plan rejections). */
  planId?: string
  results: PlanRefResult[]
  /** The event's queue view after the fast phase. */
  queueAfter: QueueItemPublic[]
  /** Slow actions, results pending in plan.result. */
  deferred: Array<{ ref: string; kind: PlanActionKind }>
}
