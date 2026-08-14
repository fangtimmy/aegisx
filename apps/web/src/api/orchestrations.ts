import { apiRequest } from "./client"
import type { OrchestrationInfo } from "./types"

/** GET /api/orchestrations — plugin registry for the create-run dialog:
 * id / scope / TypeBox params schema / template keys. */
export function listOrchestrations() {
  return apiRequest<{ items: OrchestrationInfo[] }>("/orchestrations")
}
