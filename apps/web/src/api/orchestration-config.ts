import { apiRequest, jsonRequest } from "./client"

/** GET /api/orchestration-config — one declared slot's resolved state. */
type ConfigSlot = {
  slot: string
  role: string
  name: string
  entry: boolean
  /** Configured model ref (`<providerKey>/<modelId>:<effort>` | `alias:<id>`),
   * or null = fall back to the global default model. */
  model: string | null
}

/** GET /api/orchestration-config — a plugin's public descriptor + the
 * currently-configured model ref per slot. Mirrors the server's
 * OrchestrationPublic (no `params` — models come purely from these slots). */
export type OrchestrationConfig = {
  id: string
  scope: "challenge" | "event"
  label: string
  description: string
  agents: ConfigSlot[]
  /** The plugin's own registered default template bodies (reset source). */
  templates: Record<string, string>
  /** Every template key this plugin references (slots + spawn + initial). */
  templateKeys: string[]
}

/** GET /api/orchestration-config — every plugin with its slots + configured
 * model refs. */
export function listOrchestrationConfig() {
  return apiRequest<{ items: OrchestrationConfig[] }>("/orchestration-config")
}

/** PATCH /api/orchestration-config/:pluginId — set one or more slot model refs.
 * A null ref clears the slot (fall back to the global default). */
export function updateSlotModels(
  pluginId: string,
  slots: Record<string, string | null>
) {
  return apiRequest<Record<string, string>>(
    `/orchestration-config/${pluginId}`,
    jsonRequest("PATCH", { slots })
  )
}
