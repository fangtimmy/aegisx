import { Type } from "typebox"

/** No body allowed (action endpoints that only take path params). */
export const EmptyInputSchema = Type.Object({}, { additionalProperties: false })

export const ProviderTypeSchema = Type.Union([
  Type.Literal("openai-compatible"),
  Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"),
])

export const RemoteTargetInfoSchema = Type.Object(
  {
    name: Type.String(),
    services: Type.Array(Type.String()),
  },
  { additionalProperties: false }
)
