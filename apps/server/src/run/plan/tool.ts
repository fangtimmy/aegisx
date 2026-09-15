import type { Plan, SubmitPlanResult } from "@aegisx/shared"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type { Principal } from "../../infrastructure/agent-auth"
import { planInputSchema } from "./schema"

/** The decision engine's registration half (wired by the composition root):
 * registering a plan is NOT consuming it — consumption happens only at the
 * scheduler's clean turn settle with a matching turn generation. */
type PlanRegistration = {
  schedulerAgentId: string
  /** The turn generation the tool call happened in — stamped by the handler
   * from the kernel's read-only accessor at call time. */
  turnGeneration: number
  /** Whether every action of the submitted plan is a noOp (an explicit
   * no-decision arms the engine's quiet-fingerprint / stall machinery). */
  allNoOp: boolean
}

export type SubmitPlanToolDeps = {
  /** The plan applier's submission verb, in-process (the HTTP endpoint's
   * exact counterpart — same validation, same facts, same phases). */
  submitPlan(
    eventId: string,
    plan: Plan,
    principal: Principal
  ): Promise<SubmitPlanResult>
  turnGenerationOf(agentId: string): number
  registerPlan(registration: PlanRegistration): void
}

/**
 * The scheduler's native `submit_plan` tool (control-plane §3.1): the ONE
 * management write, called in-turn instead of over the container HTTP
 * bypass. The handler calls the plan applier directly with the scheduler
 * agent's principal and returns the SubmitPlanResult (per-ref outcomes +
 * queueAfter) as the tool result — validation errors reach the model in the
 * same JSON shape the HTTP face produces. Whenever the proposal actually
 * landed (the result carries a planId) it registers
 * (schedulerAgentId, turnGeneration) with the decision engine; the engine
 * consumes the registration only at the turn's clean settle with a matching
 * generation.
 */
export function createSubmitPlanTool(
  deps: SubmitPlanToolDeps,
  ctx: { agentId: string; eventId: string }
): ToolDefinition {
  return defineTool({
    name: "submit_plan",
    label: "Submit plan",
    description:
      "Close the current decision point with your typed plan: a 1-3 sentence rationale plus ordered actions (listing order IS application order). Fast actions apply immediately and their per-ref results + the resulting queue come back in the same tool result; slow actions (stop/close/finish/cold wakes) report later through plan.result. A ref that fails VALIDATION (unknown target, wrong state, duplicate ref) rejects the WHOLE plan before anything applies — fix the failing refs and resubmit within the same turn. A ref that fails DURING application still counts: the plan is recorded and this decision point is answered; its ok:false result is in the same tool result and its ref is burned (resubmitting it replays the original outcome or rejects duplicate_ref — recover with a NEW ref). A deliberate no-op IS a plan: submit a single noOp action with a reason. A turn that ends without an accepted submit_plan is a protocol violation.",
    parameters: planInputSchema,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const principal: Principal = {
        kind: "agent",
        agentId: ctx.agentId,
        eventId: ctx.eventId,
        challengeId: null,
        role: "orchestrator",
      }
      const result = await deps.submitPlan(ctx.eventId, params, principal)
      // Register whenever the proposal actually landed (result.planId set):
      // validation-phase rejections propose nothing and the turn still owes
      // its plan, but an APPLY-phase fast-action failure lands plan.proposed
      // first — the per-ref ok:false outcomes arrive in this same result, the
      // failed refs are burned (resubmitting one replays the original outcome
      // or rejects duplicate_ref; recovery uses new refs), and the decision
      // point counts as answered.
      if (result.planId != null) {
        deps.registerPlan({
          schedulerAgentId: ctx.agentId,
          turnGeneration: deps.turnGenerationOf(ctx.agentId),
          allNoOp: params.actions.every((action) => action.kind === "noOp"),
        })
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: {},
      }
    },
  })
}
