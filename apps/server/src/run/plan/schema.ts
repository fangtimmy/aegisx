import { Type } from "typebox"

/**
 * The canonical plan schema (control-plane §B word list v1): the ONE TypeBox
 * source shared by the HTTP plan endpoint (run/routes.ts) and the native
 * submit_plan tool (run/plan/tool.ts) — the tool's JSON Schema serializes
 * from these same definitions, so the model-facing surface and the wire
 * surface cannot drift.
 *
 * PLACEMENT: TypeBox is a runtime validator, and @aegisx/shared has no
 * runtime code path (AGENTS.md) — so the schema lives here in the server
 * while the pure wire types (Plan / PlanAction / SubmitPlanResult) stay in
 * @aegisx/shared/plan.ts as the shared-owned contract.
 */

const planRefSchema = Type.String({ minLength: 1, maxLength: 64 })

const planActionSchema = Type.Union([
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("enqueue"),
      challengeId: Type.String({ minLength: 1 }),
      prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
      model: Type.Optional(Type.String({ maxLength: 300 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("message"),
      agentId: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1, maxLength: 20_000 }),
      urgent: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("stop"),
      agentId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("close"),
      agentId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("finish"),
      agentId: Type.String({ minLength: 1 }),
      summary: Type.String({ minLength: 1, maxLength: 20_000 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("setDeadline"),
      agentId: Type.String({ minLength: 1 }),
      timeoutMs: Type.Integer({ minimum: 60_000 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("cancelItem"),
      itemId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("reorder"),
      itemIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("setQueuePaused"),
      paused: Type.Boolean(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRefSchema,
      kind: Type.Literal("noOp"),
      reason: Type.String({ minLength: 1, maxLength: 4_000 }),
    },
    { additionalProperties: false }
  ),
])

/** The plan document: rationale required, actions capped at 50. An EMPTY
 * action list passes the schema and is rejected by the applier as an
 * empty_plan outcome (not a schema error). */
export const planInputSchema = Type.Object(
  {
    rationale: Type.String({ minLength: 1, maxLength: 4_000 }),
    actions: Type.Array(planActionSchema, { maxItems: 50 }),
  },
  { additionalProperties: false }
)

/** Canonical wire form of a (flat) action for dedup comparison — key order
 * normalized so two spellings of the same action match. The applier computes
 * it at submit time; the projector computes it when maintaining plan_refs —
 * one definition so the two can never disagree. */
export function canonicalActionOf(action: object): string {
  return JSON.stringify(action, Object.keys(action).toSorted())
}
