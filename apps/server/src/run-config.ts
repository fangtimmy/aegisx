import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { AgentRuntimeSnapshot, ThinkingLevel } from "../../shared/api"
import {
  type PromptTemplateContext,
  type PromptTemplates,
  resolvePromptTemplates,
} from "./prompt-templates"

export type EnvironmentConfig =
  | { type: "local" }
  | {
      type: "container"
      image: string
      cpus: number
      memoryMb: number
      pidsLimit: number
    }

export type ModelConfig = {
  provider: string
  providerLabel?: string
  modelId: string
  modelLabel?: string
  baseUrl?: string
  costKnown?: boolean
  thinkingLevel: ModelThinkingLevel
}

export type FrozenPromptConfig = PromptTemplates & {
  context?: PromptTemplateContext
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}

function isPromptTemplateContext(
  value: unknown
): value is PromptTemplateContext {
  if (!isRecord(value)) return false
  const agent = value.agent
  const event = value.event
  const challenge = value.challenge
  const model = value.model
  const run = value.run
  const capabilities = value.capabilities
  if (
    !isRecord(agent) ||
    !isRecord(event) ||
    !isRecord(challenge) ||
    !isRecord(model) ||
    !isRecord(run) ||
    !isRecord(capabilities)
  ) {
    return false
  }
  return (
    (agent.role === "main" || agent.role === "child") &&
    isBoolean(agent.isMain) &&
    isString(agent.name) &&
    isNullableString(agent.task) &&
    isString(event.id) &&
    isString(event.name) &&
    isNullableString(event.platform) &&
    isString(challenge.id) &&
    isString(challenge.name) &&
    isString(challenge.description) &&
    isNullableString(challenge.category) &&
    (challenge.points === null || isNumber(challenge.points)) &&
    Array.isArray(challenge.attachments) &&
    challenge.attachments.every(
      (attachment) =>
        isRecord(attachment) &&
        isString(attachment.name) &&
        isString(attachment.path) &&
        isNumber(attachment.size)
    ) &&
    Array.isArray(challenge.attachmentPaths) &&
    challenge.attachmentPaths.every(isString) &&
    isString(model.provider) &&
    isString(model.name) &&
    isString(model.id) &&
    isString(run.id) &&
    (run.environment === "local" || run.environment === "container") &&
    isBoolean(run.isContainer) &&
    isString(run.workspace) &&
    isBoolean(run.targetSupported) &&
    isBoolean(run.platformIntegrated) &&
    isNullableString(run.containerImage) &&
    (run.cpus === null || isNumber(run.cpus)) &&
    (run.memoryMb === null || isNumber(run.memoryMb)) &&
    (run.pidsLimit === null || isNumber(run.pidsLimit)) &&
    isBoolean(capabilities.canFinishRun) &&
    isBoolean(capabilities.canSpawnAgent) &&
    isBoolean(capabilities.canSubmitFlag) &&
    isBoolean(capabilities.canManageTarget)
  )
}

function isRuntimeTool(
  value: unknown
): value is AgentRuntimeSnapshot["tools"][number] {
  if (!isRecord(value)) return false
  return (
    isString(value.name) &&
    isString(value.description) &&
    (value.promptGuidelines === undefined ||
      (Array.isArray(value.promptGuidelines) &&
        value.promptGuidelines.every(isString)))
  )
}

export function parseEnvironment(value: string): EnvironmentConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return { type: "local" }
    if (parsed.type !== "container" || !isString(parsed.image)) {
      return { type: "local" }
    }
    return {
      type: "container",
      image: parsed.image,
      cpus: isNumber(parsed.cpus) ? parsed.cpus : 1,
      memoryMb: isNumber(parsed.memoryMb) ? parsed.memoryMb : 512,
      pidsLimit: isNumber(parsed.pidsLimit) ? parsed.pidsLimit : 128,
    }
  } catch {
    return { type: "local" }
  }
}

export function parsePromptConfig(value: string): FrozenPromptConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error("Invalid prompt config")
    return {
      ...resolvePromptTemplates({
        mainSystemPromptTemplate: isString(parsed.mainSystemPromptTemplate)
          ? parsed.mainSystemPromptTemplate
          : "",
        childSystemPromptTemplate: isString(parsed.childSystemPromptTemplate)
          ? parsed.childSystemPromptTemplate
          : "",
        initialPromptTemplate: isString(parsed.initialPromptTemplate)
          ? parsed.initialPromptTemplate
          : "",
        systemPromptTemplate: isString(parsed.systemPromptTemplate)
          ? parsed.systemPromptTemplate
          : undefined,
      }),
      ...(isPromptTemplateContext(parsed.context)
        ? { context: parsed.context }
        : {}),
    }
  } catch {
    return resolvePromptTemplates({
      mainSystemPromptTemplate: "",
      childSystemPromptTemplate: "",
      initialPromptTemplate: "",
    })
  }
}

export function parseModelConfig(value: string): ModelConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error("Invalid model config")
    return {
      provider: isString(parsed.provider) ? parsed.provider : "",
      ...(isString(parsed.providerLabel)
        ? { providerLabel: parsed.providerLabel }
        : {}),
      modelId: isString(parsed.modelId) ? parsed.modelId : "",
      ...(isString(parsed.modelLabel) ? { modelLabel: parsed.modelLabel } : {}),
      ...(isString(parsed.baseUrl) ? { baseUrl: parsed.baseUrl } : {}),
      ...(parsed.costKnown === false ? { costKnown: false } : {}),
      thinkingLevel: isThinkingLevel(parsed.thinkingLevel)
        ? parsed.thinkingLevel
        : "off",
    }
  } catch {
    return { provider: "", modelId: "", thinkingLevel: "off" }
  }
}

export function parseRuntimeSnapshot(
  value: string | null
): AgentRuntimeSnapshot | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed) || !isRecord(parsed.model)) return null
    if (
      !isString(parsed.capturedAt) ||
      !isString(parsed.systemPrompt) ||
      !isString(parsed.cwd) ||
      !isString(parsed.model.provider) ||
      !isString(parsed.model.modelId) ||
      !Array.isArray(parsed.tools) ||
      !parsed.tools.every(isRuntimeTool)
    ) {
      return null
    }
    return {
      capturedAt: parsed.capturedAt,
      systemPrompt: parsed.systemPrompt,
      cwd: parsed.cwd,
      model: {
        provider: parsed.model.provider,
        modelId: parsed.model.modelId,
        thinkingLevel: isThinkingLevel(parsed.model.thinkingLevel)
          ? parsed.model.thinkingLevel
          : "off",
      },
      tools: parsed.tools,
    }
  } catch {
    return null
  }
}
