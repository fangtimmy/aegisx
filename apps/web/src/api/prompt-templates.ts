import { apiRequest, jsonRequest } from "./client"
import type { PromptTemplateRow } from "./types"

/** GET /api/prompt-templates — all rows (plugin-grouped by the client). */
export function listTemplates() {
  return apiRequest<{ items: PromptTemplateRow[] }>("/prompt-templates")
}

/** PATCH /api/prompt-templates — upsert one (plugin, key) row; returns the
 * full updated list so the caller can refresh its cache in one write. */
export function updateTemplate(input: {
  plugin: string
  key: string
  body: string
}) {
  return apiRequest<{ items: PromptTemplateRow[] }>(
    "/prompt-templates",
    jsonRequest("PATCH", input)
  )
}
