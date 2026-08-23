import { isRecord } from "@aegisx/shared"
import type { ProviderType } from "@aegisx/shared/domain"
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelCost,
  type ModelThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai"
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all"

import { parseJson } from "../lib/guards"

export type { ThinkingLevelMap }

export type ModelMetadata = {
  reasoning: boolean
  thinkingLevelMap: ThinkingLevelMap
  input: Array<"text" | "image">
  cost: ModelCost
  costKnown: boolean
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}

export type BuiltinModelProfile = {
  providerId: string
  modelId: string
  name: string
  metadata: ModelMetadata
}

const thinkingLevels: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const defaultModelMetadata: ModelMetadata = {
  reasoning: false,
  thinkingLevelMap: {},
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costKnown: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message)
  }
  return value
}

function nonNegativeNumber(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function metadataCost(value: unknown): ModelCost {
  const cost = record(value, "cost must be an object")
  const base = {
    input: nonNegativeNumber(cost.input, "cost.input"),
    output: nonNegativeNumber(cost.output, "cost.output"),
    cacheRead: nonNegativeNumber(cost.cacheRead, "cost.cacheRead"),
    cacheWrite: nonNegativeNumber(cost.cacheWrite, "cost.cacheWrite"),
  }
  if (cost.tiers === undefined) return base
  if (!Array.isArray(cost.tiers)) throw new Error("cost.tiers must be an array")
  return {
    ...base,
    tiers: cost.tiers.map((tier) => {
      const tierCost = record(tier, "cost.tiers entries must be objects")
      return {
        ...metadataCost(tierCost),
        inputTokensAbove: positiveInteger(
          tierCost.inputTokensAbove,
          "cost.tiers.inputTokensAbove"
        ),
      }
    }),
  }
}

export function normalizeModelMetadata(value: unknown): ModelMetadata {
  const input = record(value, "Metadata must be a JSON object")
  const allowed = new Set([
    "reasoning",
    "thinkingLevelMap",
    "input",
    "cost",
    "costKnown",
    "contextWindow",
    "maxTokens",
    "headers",
    "compat",
  ])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown metadata field: ${key}`)
  }
  const thinkingLevelMap =
    input.thinkingLevelMap === undefined
      ? defaultModelMetadata.thinkingLevelMap
      : parseThinkingLevelMap(
          JSON.stringify(
            record(input.thinkingLevelMap, "thinkingLevelMap must be an object")
          )
        )
  const modelInput =
    input.input === undefined
      ? defaultModelMetadata.input
      : (() => {
          if (!Array.isArray(input.input) || input.input.length === 0) {
            throw new Error("input must be a non-empty array")
          }
          const values = [...new Set(input.input)]
          if (
            !values.every(
              (item): item is "text" | "image" =>
                item === "text" || item === "image"
            )
          ) {
            throw new Error("input supports only text and image")
          }
          return values
        })()
  const headers =
    input.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(
            record(input.headers, "headers must be an object")
          ).map(([key, header]) => {
            if (!key || typeof header !== "string") {
              throw new Error("headers must contain string values")
            }
            return [key, header]
          })
        )
  const compat =
    input.compat === undefined
      ? undefined
      : record(input.compat, "compat must be an object")
  return {
    reasoning:
      input.reasoning === undefined
        ? defaultModelMetadata.reasoning
        : typeof input.reasoning === "boolean"
          ? input.reasoning
          : (() => {
              throw new Error("reasoning must be a boolean")
            })(),
    thinkingLevelMap,
    input: modelInput,
    cost:
      input.cost === undefined
        ? defaultModelMetadata.cost
        : metadataCost(input.cost),
    costKnown:
      input.costKnown === undefined
        ? defaultModelMetadata.costKnown
        : typeof input.costKnown === "boolean"
          ? input.costKnown
          : (() => {
              throw new Error("costKnown must be a boolean")
            })(),
    contextWindow:
      input.contextWindow === undefined
        ? defaultModelMetadata.contextWindow
        : positiveInteger(input.contextWindow, "contextWindow"),
    maxTokens:
      input.maxTokens === undefined
        ? defaultModelMetadata.maxTokens
        : positiveInteger(input.maxTokens, "maxTokens"),
    ...(headers ? { headers } : {}),
    ...(compat ? { compat } : {}),
  }
}

export function parseModelMetadata(value: string): ModelMetadata {
  try {
    return normalizeModelMetadata(parseJson<unknown>(value))
  } catch (error) {
    console.warn("Model metadata parse failed, using defaults", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { ...defaultModelMetadata }
  }
}

function parseThinkingLevelMap(value: string): ThinkingLevelMap {
  try {
    const parsed = parseJson<unknown>(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([level, mapped]) =>
        (thinkingLevels as readonly string[]).includes(level) &&
        (typeof mapped === "string" || mapped === null)
          ? [[level, mapped]]
          : []
      )
    )
  } catch {
    return {}
  }
}

export function supportedThinkingLevels(metadata: ModelMetadata) {
  return getSupportedThinkingLevels({
    ...metadata,
    id: "metadata",
    name: "metadata",
    api: "openai-completions",
    provider: "metadata",
    baseUrl: "http://localhost",
  })
}

/** Map AegisX ProviderType → pi api stream identifier. */
export const providerApi = (
  type: ProviderType
): "openai-completions" | "openai-responses" | "anthropic-messages" =>
  type === "openai-compatible"
    ? "openai-completions"
    : type === "openai-responses"
      ? "openai-responses"
      : "anthropic-messages"

function metadataFromModel(model: Model<Api>): ModelMetadata {
  const costKnown = [
    model.cost.input,
    model.cost.output,
    model.cost.cacheRead,
    model.cost.cacheWrite,
  ].every((value) => value >= 0)
  return normalizeModelMetadata({
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: model.input,
    cost: costKnown ? model.cost : defaultModelMetadata.cost,
    costKnown,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat
      ? { compat: Object.fromEntries(Object.entries(model.compat)) }
      : {}),
  })
}

/**
 * Read pi's built-in model catalog (read-only). Used by the settings UI to list
 * bindable pi built-in models and to source their metadata. v3 keeps pi-ai only
 * for this read-only metadata lookup; the agent loop runs inside the container.
 */
export function builtinModelProfiles(): BuiltinModelProfile[] {
  return getBuiltinProviders().flatMap((providerId) =>
    getBuiltinModels(providerId).map((model) => ({
      providerId,
      modelId: model.id,
      name: model.name,
      metadata: metadataFromModel(model),
    }))
  )
}

export function builtinModelProfile(providerId: string, modelId: string) {
  return builtinModelProfiles().find(
    (model) => model.providerId === providerId && model.modelId === modelId
  )
}
