import type { RunUsage } from "./run"
import type { ThinkingLevel } from "./thinking"

/** Per-event orchestrator row projection (mirrors the `orchestrators` table). */
export type OrchestratorPublic = {
  eventId: string
  enabled: boolean
  /** ProviderModel.id; null = fall back to the global default model. */
  modelId: string | null
  thinkingLevel: ThinkingLevel
  /** Natural-language steering ("hit crypto first, leave pwn for last"). */
  instruction: string
  maxConcurrentTargets: number
  status: "running" | "idle" | "closed"
  createdAt: string
  updatedAt: string
}

/** Live status snapshot returned alongside the config. */
export type OrchestratorStatus = {
  running: number
  maxConcurrentRuns: number
  inflightTargets: number
  maxConcurrentTargets: number
}

/** GET response: config + live status. */
export type OrchestratorDetail = {
  orchestrator: OrchestratorPublic
  status: OrchestratorStatus
  usage?: RunUsage
}

/** PATCH body for the orchestrator config. */
export type OrchestratorConfigInput = {
  enabled?: boolean
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
  instruction?: string
  maxConcurrentTargets?: number
}
