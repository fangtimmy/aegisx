import { apiRequest, jsonRequest } from "./client"
import type { ModelAlias, ThinkingLevel } from "./types"

export type CreateAliasInput = {
  label: string
  /** Ordered list of ProviderModel.id values (v1 UI exposes one). */
  modelIds: string[]
  thinkingLevel: ThinkingLevel
}

export type PatchAliasInput = Partial<{
  label: string
  modelIds: string[]
  thinkingLevel: ThinkingLevel
}>

export function listAliases() {
  return apiRequest<{ items: ModelAlias[] }>("/model-aliases")
}

export function createAlias(input: CreateAliasInput) {
  return apiRequest<ModelAlias>("/model-aliases", jsonRequest("POST", input))
}

export function updateAlias(id: string, input: PatchAliasInput) {
  return apiRequest<ModelAlias>(
    `/model-aliases/${id}`,
    jsonRequest("PATCH", input)
  )
}

export function deleteAlias(id: string) {
  return apiRequest<void>(`/model-aliases/${id}`, { method: "DELETE" })
}
