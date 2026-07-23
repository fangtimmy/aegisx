import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import { type Static, Type } from "typebox"
import { Value } from "typebox/value"
import type {
  AgentRuntimeSnapshot,
  EnvironmentConfig,
  FrozenPromptConfig,
  ModelConfig,
  PromptAttachment,
  PromptTemplateContext,
  ThinkingLevel,
} from "../../../shared"
import { normalizeThinkingLevel } from "../../../shared"
import { isRecord } from "../lib/guards"
import { ThinkingLevelSchema } from "../lib/schemas"

export type {
  AgentRuntimeSnapshot,
  EnvironmentConfig,
  FrozenPromptConfig,
  ModelConfig,
  ModelThinkingLevel,
  PromptAttachment,
  PromptTemplateContext,
  ThinkingLevel,
}

const ModelConfigSchema = Type.Object(
  {
    provider: Type.String(),
    providerLabel: Type.Optional(Type.String()),
    modelId: Type.String(),
    modelLabel: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
    costKnown: Type.Optional(Type.Boolean()),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false }
)

const LocalEnvironmentSchema = Type.Object(
  { type: Type.Literal("local") },
  { additionalProperties: false }
)

const ContainerEnvironmentSchema = Type.Object(
  {
    type: Type.Literal("container"),
    image: Type.String(),
    cpus: Type.Optional(Type.Number()),
    memoryMb: Type.Optional(Type.Number()),
    pidsLimit: Type.Optional(Type.Number()),
  },
  { additionalProperties: false }
)

const EnvironmentSchema = Type.Union([
  LocalEnvironmentSchema,
  ContainerEnvironmentSchema,
])

const PromptAttachmentSchema = Type.Object(
  {
    name: Type.String(),
    path: Type.String(),
    size: Type.Number(),
  },
  { additionalProperties: false }
)

const PromptTemplateContextSchema = Type.Object(
  {
    agent: Type.Object(
      {
        role: Type.Union([Type.Literal("main"), Type.Literal("child")]),
        isMain: Type.Boolean(),
        name: Type.String(),
        task: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false }
    ),
    event: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
        platform: Type.Union([Type.String(), Type.Null()]),
        promptHint: Type.String(),
      },
      { additionalProperties: false }
    ),
    challenge: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
        description: Type.String(),
        category: Type.Union([Type.String(), Type.Null()]),
        points: Type.Union([Type.Number(), Type.Null()]),
        attachments: Type.Array(PromptAttachmentSchema),
        attachmentPaths: Type.Array(Type.String()),
      },
      { additionalProperties: false }
    ),
    model: Type.Object(
      {
        provider: Type.String(),
        name: Type.String(),
        id: Type.String(),
      },
      { additionalProperties: false }
    ),
    run: Type.Object(
      {
        id: Type.String(),
        environment: Type.Union([
          Type.Literal("local"),
          Type.Literal("container"),
        ]),
        isContainer: Type.Boolean(),
        workspace: Type.String(),
        targetSupported: Type.Boolean(),
        platformIntegrated: Type.Boolean(),
        containerImage: Type.Union([Type.String(), Type.Null()]),
        cpus: Type.Union([Type.Number(), Type.Null()]),
        memoryMb: Type.Union([Type.Number(), Type.Null()]),
        pidsLimit: Type.Union([Type.Number(), Type.Null()]),
      },
      { additionalProperties: false }
    ),
    capabilities: Type.Object(
      {
        canFinishRun: Type.Boolean(),
        canSpawnAgent: Type.Boolean(),
        canSubmitFlag: Type.Boolean(),
        canManageTarget: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
)

const FrozenPromptConfigSchema = Type.Object(
  {
    mainSystemPromptTemplate: Type.Optional(Type.String()),
    childSystemPromptTemplate: Type.Optional(Type.String()),
    initialPromptTemplate: Type.Optional(Type.String()),
    context: Type.Optional(PromptTemplateContextSchema),
  },
  { additionalProperties: false }
)

const RuntimeToolSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    parameters: Type.Optional(Type.Unknown()),
    promptGuidelines: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true }
)

const RuntimeSnapshotSchema = Type.Object(
  {
    capturedAt: Type.String(),
    systemPrompt: Type.String(),
    cwd: Type.String(),
    model: Type.Object(
      {
        provider: Type.String(),
        modelId: Type.String(),
        thinkingLevel: Type.Optional(ThinkingLevelSchema),
      },
      { additionalProperties: false }
    ),
    tools: Type.Array(RuntimeToolSchema),
  },
  { additionalProperties: false }
)

export function parseModelConfig(value: string): ModelConfig {
  try {
    const cleaned = Value.Clean(
      ModelConfigSchema,
      JSON.parse(value) as unknown
    ) as Static<typeof ModelConfigSchema>
    return {
      provider: typeof cleaned.provider === "string" ? cleaned.provider : "",
      modelId: typeof cleaned.modelId === "string" ? cleaned.modelId : "",
      thinkingLevel: normalizeThinkingLevel(cleaned.thinkingLevel),
      ...(typeof cleaned.providerLabel === "string"
        ? { providerLabel: cleaned.providerLabel }
        : {}),
      ...(typeof cleaned.modelLabel === "string"
        ? { modelLabel: cleaned.modelLabel }
        : {}),
      ...(typeof cleaned.baseUrl === "string"
        ? { baseUrl: cleaned.baseUrl }
        : {}),
      ...(cleaned.costKnown === false ? { costKnown: false } : {}),
    }
  } catch {
    return { provider: "", modelId: "", thinkingLevel: "off" }
  }
}

export function parseEnvironment(value: string): EnvironmentConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Value.Check(EnvironmentSchema, parsed)) return { type: "local" }
    if (parsed.type === "local") return { type: "local" }
    return {
      type: "container",
      image: parsed.image,
      cpus:
        typeof parsed.cpus === "number" && Number.isFinite(parsed.cpus)
          ? parsed.cpus
          : 2,
      memoryMb:
        typeof parsed.memoryMb === "number" && Number.isFinite(parsed.memoryMb)
          ? parsed.memoryMb
          : 2048,
      pidsLimit:
        typeof parsed.pidsLimit === "number" &&
        Number.isFinite(parsed.pidsLimit)
          ? parsed.pidsLimit
          : 256,
    }
  } catch {
    return { type: "local" }
  }
}

export function parsePromptConfig(value: string): FrozenPromptConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error("Invalid prompt config")
    const cleaned = Value.Clean(FrozenPromptConfigSchema, parsed) as Static<
      typeof FrozenPromptConfigSchema
    >
    const context =
      cleaned.context &&
      Value.Check(PromptTemplateContextSchema, cleaned.context)
        ? (cleaned.context as PromptTemplateContext)
        : undefined
    return {
      mainSystemPromptTemplate:
        typeof cleaned.mainSystemPromptTemplate === "string"
          ? cleaned.mainSystemPromptTemplate
          : "",
      childSystemPromptTemplate:
        typeof cleaned.childSystemPromptTemplate === "string"
          ? cleaned.childSystemPromptTemplate
          : "",
      initialPromptTemplate:
        typeof cleaned.initialPromptTemplate === "string"
          ? cleaned.initialPromptTemplate
          : "",
      ...(context ? { context } : {}),
    }
  } catch {
    return {
      mainSystemPromptTemplate: "",
      childSystemPromptTemplate: "",
      initialPromptTemplate: "",
    }
  }
}

export function isPromptTemplateContext(
  value: unknown
): value is PromptTemplateContext {
  return Value.Check(PromptTemplateContextSchema, value)
}

export function parseRuntimeSnapshot(
  value: string | null
): AgentRuntimeSnapshot | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Value.Check(RuntimeSnapshotSchema, parsed)) return null
    return {
      capturedAt: parsed.capturedAt,
      systemPrompt: parsed.systemPrompt,
      cwd: parsed.cwd,
      model: {
        provider: parsed.model.provider,
        modelId: parsed.model.modelId,
        thinkingLevel: normalizeThinkingLevel(parsed.model.thinkingLevel),
      },
      tools: parsed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
        ...(tool.promptGuidelines
          ? { promptGuidelines: tool.promptGuidelines }
          : {}),
      })),
    }
  } catch {
    return null
  }
}
