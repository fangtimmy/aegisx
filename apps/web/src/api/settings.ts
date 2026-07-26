import { apiRequest, jsonRequest } from "./client"
import type { FlatSettings, SettingsResponse } from "./types"

export function getSettings() {
  return apiRequest<SettingsResponse>("/settings")
}

export function updateSettings(input: Partial<FlatSettings>) {
  return apiRequest<SettingsResponse>("/settings", jsonRequest("PATCH", input))
}

export type PromptPreviewSegment = {
  id: number
  text: string
  highlighted: boolean
}

export type PromptPreview = {
  segments: PromptPreviewSegment[]
}

export function previewPrompts(input: { kind: string; template: string }) {
  return apiRequest<PromptPreview>(
    "/settings/prompts/preview",
    jsonRequest("POST", input)
  )
}

export function importSettingsPayload(body: object) {
  return apiRequest<unknown>("/settings/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}
