import { apiRequest, jsonRequest } from "./client"
import type {
  ModelMetadata,
  ModelOption,
  PiModelProfile,
  ProviderConnection,
  ProviderModel,
  ProviderType,
} from "./types"

export type CreateProviderInput = {
  label: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  enabled?: boolean
}

export type PatchProviderInput = Partial<{
  label: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  enabled: boolean
}>

export type CreateModelInput = {
  modelId: string
  label: string
  enabled?: boolean
  metadata?: Partial<ModelMetadata>
}

export type PatchModelInput = Partial<{
  label: string
  enabled: boolean
  metadata: Partial<ModelMetadata> | ModelMetadata
}>

export function listProviders() {
  return apiRequest<{ items: ProviderConnection[] }>("/providers")
}

/** Flat selectable-model list (enabled provider × enabled model), with the
 * canonical address ref selectors key on. */
export function listModels() {
  return apiRequest<{ items: ModelOption[] }>("/models")
}

export function createProvider(input: CreateProviderInput) {
  return apiRequest<ProviderConnection>(
    "/providers",
    jsonRequest("POST", input)
  )
}

export function updateProvider(id: string, input: PatchProviderInput) {
  return apiRequest<ProviderConnection>(
    `/providers/${id}`,
    jsonRequest("PATCH", input)
  )
}

export function deleteProvider(id: string) {
  return apiRequest<void>(`/providers/${id}`, { method: "DELETE" })
}

export function discoverModels(providerId: string) {
  return apiRequest<{ models: string[] }>(
    `/providers/${providerId}/models/discover`,
    { method: "POST" }
  )
}

/** One max_tokens=1 probe chat request against the provider's saved config
 * (baseUrl / apiKey / model existence in one round trip). On failure throws
 * with the upstream status + response-body summary carried in the message. */
export function testProviderModel(providerId: string, modelId: string) {
  return apiRequest<{ ok: true; latencyMs: number }>(
    `/providers/${providerId}/test`,
    jsonRequest("POST", { modelId })
  )
}

export function listBuiltinModels(providerId: string) {
  return apiRequest<{ items: PiModelProfile[] }>(
    `/providers/${providerId}/models/builtins`
  )
}

export function createProviderModel(
  providerId: string,
  input: CreateModelInput
) {
  return apiRequest<ProviderModel>(
    `/providers/${providerId}/models`,
    jsonRequest("POST", input)
  )
}

export function updateProviderModel(id: string, input: PatchModelInput) {
  return apiRequest<ProviderModel>(
    `/provider-models/${id}`,
    jsonRequest("PATCH", input)
  )
}

/** Copy a pi builtin profile's metadata onto the model (one-shot import —
 * the copy is editable afterwards; repeating re-syncs it). */
export function importProviderModelMetadata(
  id: string,
  profile: { providerId: string; modelId: string }
) {
  return apiRequest<ProviderModel>(
    `/provider-models/${id}/import`,
    jsonRequest("POST", profile)
  )
}

export function deleteProviderModel(id: string) {
  return apiRequest<void>(`/provider-models/${id}`, { method: "DELETE" })
}
