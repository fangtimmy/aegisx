import { Type } from "typebox"

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
])

export const EnvironmentSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("container"),
])

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
