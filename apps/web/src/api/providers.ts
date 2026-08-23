import { isRecord } from "@aegisx/shared"
import { fetchEventSource } from "@microsoft/fetch-event-source"

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

/** Test-dialogue stream events (SSE from POST /providers/:id/test). */
export type ProviderTestUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ProviderTestEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: ProviderTestUsage }
  | { type: "error"; message: string }

function isProviderTestEvent(value: unknown): value is ProviderTestEvent {
  if (!isRecord(value)) return false
  if (value.type === "delta") return typeof value.text === "string"
  if (value.type === "error") return typeof value.message === "string"
  return value.type === "done"
}

/** Streamed test dialogue against the provider's SAVED config — one bare
 * user message (no system prompt / tools). `onEvent` receives text deltas,
 * the terminal usage readout, or a mid-stream error; the caller times
 * TTFT / total duration client-side. Connection-level failures throw (the
 * upstream status + body summary rides in the message). */
export async function streamProviderTest(
  providerId: string,
  input: { modelId: string; prompt: string },
  onEvent: (event: ProviderTestEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  await fetchEventSource(`/api/providers/${providerId}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
    async onopen(response) {
      if (response.ok) return
      let message = `${response.status} ${response.statusText}`
      try {
        const body: unknown = await response.json()
        if (isRecord(body) && isRecord(body.error)) {
          if (typeof body.error.message === "string")
            message = body.error.message
        }
      } catch {
        // keep the HTTP status
      }
      throw new Error(message)
    },
    onmessage(message) {
      try {
        const parsed = JSON.parse(message.data)
        if (isProviderTestEvent(parsed)) onEvent(parsed)
      } catch {
        // ignore malformed frames
      }
    },
    onerror(err) {
      throw err
    },
  })
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
