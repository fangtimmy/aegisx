import type {
  ModelMetadata,
  ProviderConnection,
  ProviderModel,
} from "@aegisx/shared/provider"

import { providerApi, type ThinkingLevelMap } from "./builtin-models"

/**
 * pi models.json (per-run, written into the pi-agent volume). Generated from
 * AegisX provider/model settings without changing their structure. v3 keeps the
 * piBinding branch so a provider/model can bind a pi built-in model.
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
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  models?: PiModel[]
  /** Per-model overrides for a bound pi built-in model. */
  modelOverrides?: Record<string, Partial<PiModel>>
}

export type PiModelsJson = {
  providers: Record<string, PiProvider>
}

/** Provider key used in pi models.json for a bound pi built-in provider. */
function piProviderKeyBound(model: ProviderModel): string {
  return model.piBinding?.providerId ?? ""
}

/** Provider key used in pi models.json for a fully custom provider. */
function piProviderKeyCustom(provider: ProviderConnection): string {
  return `aegisx-${provider.id}`
}

/**
 * The (providerKey, modelId) pi should address this AegisX model with, used for
 * `--model <providerKey>/<modelId>` and settings.json enabledModels.
 */
export function resolvePiModelRef(
  provider: ProviderConnection,
  model: ProviderModel
): { providerKey: string; modelId: string } {
  return model.piBinding
    ? {
        providerKey: model.piBinding.providerId,
        modelId: model.piBinding.modelId,
      }
    : { providerKey: piProviderKeyCustom(provider), modelId: model.modelId }
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

/**
 * Build pi models.json from enabled AegisX providers/models.
 *
 * - piBinding models emit a provider entry under the builtin providerId with the
 *   AegisX provider's baseUrl/apiKey/headers so requests route to the user's
 *   gateway; pi's built-in model definition is used.
 * - custom models emit a provider entry under aegisx-<id> with full model defs.
 */
export function generateModelsJson(
  providers: ProviderConnection[]
): PiModelsJson {
  const json: PiModelsJson = { providers: {} }

  for (const provider of providers) {
    if (!provider.enabled || !provider.apiKey) continue
    const enabledModels = provider.models.filter((model) => model.enabled)
    if (enabledModels.length === 0) continue

    for (const model of enabledModels) {
      if (model.piBinding) {
        const key = piProviderKeyBound(model)
        const entry: PiProvider = json.providers[key] ?? {}
        // Route builtin-model requests to the user's endpoint/key.
        if (provider.baseUrl) entry.baseUrl = provider.baseUrl
        entry.apiKey = provider.apiKey
        if (model.metadata.headers) {
          entry.headers = {
            ...entry.headers,
            ...model.metadata.headers,
          }
        }
        // Optional per-model overrides (headers/compat from metadata).
        if (model.metadata.compat) {
          entry.modelOverrides = {
            ...entry.modelOverrides,
            [model.piBinding.modelId]: {
              ...(model.metadata.headers
                ? { headers: model.metadata.headers }
                : {}),
              compat: model.metadata.compat,
            },
          }
        }
        json.providers[key] = entry
      } else {
        const key = piProviderKeyCustom(provider)
        const entry: PiProvider = json.providers[key] ?? {
          baseUrl: provider.baseUrl,
          api: providerApi(provider.type),
          apiKey: provider.apiKey,
        }
        entry.baseUrl = provider.baseUrl
        entry.api = providerApi(provider.type)
        entry.apiKey = provider.apiKey
        entry.models = [...(entry.models ?? []), modelToPiModel(model)]
        json.providers[key] = entry
      }
    }
  }

  return json
}
