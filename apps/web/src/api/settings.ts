import { apiRequest, jsonRequest } from "./client"
import type { SettingsPublic } from "./types"

export function getSettings() {
  return apiRequest<SettingsPublic>("/settings")
}

export function updateSettings(input: Partial<SettingsPublic>) {
  return apiRequest<SettingsPublic>("/settings", jsonRequest("PATCH", input))
}

export function updatePrompts(
  input: Pick<
    SettingsPublic,
    | "mainSystemPromptTemplate"
    | "childSystemPromptTemplate"
    | "initialPromptTemplate"
  >
) {
  return apiRequest<SettingsPublic>(
    "/settings/prompts",
    jsonRequest("PATCH", input)
  )
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
