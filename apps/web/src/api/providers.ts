import { apiRequest, jsonRequest } from "./client"
import type {
  ModelMetadata,
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
  binding: { providerId: string; modelId: string } | null
}>

export function listProviders() {
  return apiRequest<{ items: ProviderConnection[] }>("/providers")
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

export function deleteProviderModel(id: string) {
  return apiRequest<void>(`/provider-models/${id}`, { method: "DELETE" })
}
