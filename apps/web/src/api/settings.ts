import { apiRequest, jsonRequest } from "./client"
import type { SettingKey, SettingsResponse } from "./types"

export function getSettings() {
  return apiRequest<SettingsResponse>("/settings")
}

export function updateSettings(input: Partial<Record<SettingKey, unknown>>) {
  return apiRequest<SettingsResponse>("/settings", jsonRequest("PATCH", input))
}

type PromptPreviewSegment = {
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
