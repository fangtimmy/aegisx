import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { Value } from "typebox/value"
import type { AegisXMessage, AegisXMetadata, InboxKind } from "../../../shared"

export type { AegisXMessage, AegisXMetadata, InboxKind }

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    aegisx: AegisXMessage
  }
}

const TextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: true }
)

const ImageContentSchema = Type.Object(
  {
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
  },
  { additionalProperties: true }
)

const ThinkingContentSchema = Type.Object(
  {
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    thinkingSignature: Type.Optional(Type.String()),
    redacted: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true }
)

const ToolCallContentSchema = Type.Object(
  {
    type: Type.Literal("toolCall"),
    id: Type.String(),
    name: Type.String(),
    arguments: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: true }
)

const TextOrImageSchema = Type.Union([TextContentSchema, ImageContentSchema])

const UsageSchema = Type.Object(
  {
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    totalTokens: Type.Number(),
    cost: Type.Object(
      {
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
        total: Type.Number(),
      },
      { additionalProperties: true }
    ),
  },
  { additionalProperties: true }
)

const UserMessageSchema = Type.Object(
  {
    role: Type.Literal("user"),
    timestamp: Type.Number(),
    content: Type.Union([Type.String(), Type.Array(TextOrImageSchema)]),
  },
  { additionalProperties: true }
)

const AssistantMessageSchema = Type.Object(
  {
    role: Type.Literal("assistant"),
    timestamp: Type.Number(),
    api: Type.String(),
    provider: Type.String(),
    model: Type.String(),
    content: Type.Array(
      Type.Union([
        TextContentSchema,
        ThinkingContentSchema,
        ToolCallContentSchema,
      ])
    ),
    usage: UsageSchema,
    stopReason: Type.Union([
      Type.Literal("stop"),
      Type.Literal("length"),
      Type.Literal("toolUse"),
      Type.Literal("error"),
      Type.Literal("aborted"),
    ]),
  },
  { additionalProperties: true }
)

const ToolResultMessageSchema = Type.Object(
  {
    role: Type.Literal("toolResult"),
    timestamp: Type.Number(),
    toolCallId: Type.String(),
    toolName: Type.String(),
    content: Type.Array(TextOrImageSchema),
    isError: Type.Boolean(),
  },
  { additionalProperties: true }
)

const InboxKindSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("child_result"),
  Type.Literal("resume"),
])

const AegisXMetadataSchema = Type.Object(
  {
    handoff: Type.Optional(
      Type.Object(
        {
          agentId: Type.String(),
          agentName: Type.String(),
          status: Type.String(),
        },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
)

const AegisXMessageSchema = Type.Object(
  {
    role: Type.Literal("aegisx"),
    id: Type.String(),
    kind: InboxKindSchema,
    text: Type.String(),
    timestamp: Type.Number(),
    metadata: Type.Optional(AegisXMetadataSchema),
  },
  { additionalProperties: true }
)

const AgentMessageSchema = Type.Union([
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  AegisXMessageSchema,
])

export function parseAgentMessage(value: string): AgentMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Persisted agent message is invalid")
  }
  if (!Value.Check(AgentMessageSchema, parsed)) {
    throw new Error("Persisted agent message is invalid")
  }
  return parsed as AgentMessage
}

export function parseInboxMetadata(value: string): AegisXMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return Value.Check(AegisXMetadataSchema, parsed)
      ? (parsed as AegisXMetadata)
      : undefined
  } catch {
    return undefined
  }
}

export function isInboxKind(value: unknown): value is InboxKind {
  return Value.Check(InboxKindSchema, value)
}
