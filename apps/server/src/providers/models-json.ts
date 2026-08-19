import { modelProviderKey } from "@aegisx/shared"
import type {
  ModelMetadata,
  ProviderConnection,
  ProviderModel,
} from "@aegisx/shared/domain"

import { providerApi, type ThinkingLevelMap } from "./builtin-models"

/**
 * pi models.json (per-run, written into the pi-agent volume). Generated from
 * AegisX provider/model settings without changing their structure.
 *
 * Every enabled provider emits one entry under its `aegisx-<providerId>` key
 * with full model definitions — metadata is local to AegisX (pi's builtin
 * catalog is only a metadata source at import time), so refs stay stable
 * regardless of where a model's metadata came from.
 *
 * Resolution order in the container: CLI --api-key > auth.json > env > models.json
 * provider apiKey. The container has no auth.json and we control env, so the
 * literal apiKey written here is authoritative.
 */
type PiApi = "openai-completions" | "openai-responses" | "anthropic-messages"

type PiModel = {
  id: string
  name: string
  reasoning?: boolean
  input?: Array<"text" | "image">
  cost?: ModelMetadata["cost"]
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: ThinkingLevelMap
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}

type PiProvider = {
  baseUrl?: string
  api?: PiApi
  apiKey?: string
  models?: PiModel[]
}

export type PiModelsJson = {
  providers: Record<string, PiProvider>
}

function modelToPiModel(model: ProviderModel): PiModel {
  const { reasoning, input, cost, contextWindow, maxTokens, thinkingLevelMap } =
    model.metadata
  const piModel: PiModel = {
    id: model.modelId,
    name: model.label,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
  }
  if (Object.keys(thinkingLevelMap).length > 0) {
    piModel.thinkingLevelMap = thinkingLevelMap
  }
  if (model.metadata.headers) piModel.headers = model.metadata.headers
  if (model.metadata.compat) piModel.compat = model.metadata.compat
  return piModel
}

/** Build pi models.json from enabled AegisX providers/models. */
export function generateModelsJson(
  providers: ProviderConnection[]
): PiModelsJson {
  const json: PiModelsJson = { providers: {} }

  for (const provider of providers) {
    if (!provider.enabled || !provider.apiKey) continue
    const models = provider.models
      .filter((model) => model.enabled)
      .map(modelToPiModel)
    if (models.length === 0) continue
    json.providers[modelProviderKey(provider)] = {
      baseUrl: provider.baseUrl,
      api: providerApi(provider.type),
      apiKey: provider.apiKey,
      models,
    }
  }

  return json
}
