import type { PromptAttachment } from "@aegisx/shared"

// --- per-agent capabilities (derived from the agent's tool list) -----------

/** Per-agent capability flags. Derived from the agent's `tools` array,
 * NOT from the run/challenge — so each agent's rendered system
 * prompt advertises exactly the abilities its tool set grants. */
export type Capabilities = {
  canFinish: boolean
  canSubmitFlag: boolean
  canManageTarget: boolean
}

/** Derive per-agent capabilities from a tool-name list:
 *  - canFinish       = has `finish_run`
 *  - canSubmitFlag   = has `submit_flag`
 *  - canManageTarget = has any `*_target`
 * File tools (read/bash/edit/write) are always on and never listed, so they
 * contribute nothing here. */
export function deriveCapabilities(tools: string[]): Capabilities {
  return {
    canFinish: tools.includes("finish_run"),
    canSubmitFlag: tools.includes("submit_flag"),
    canManageTarget: tools.some((name) => name.endsWith("_target")),
  }
}

// --- unified, scope-aware prompt render context --------------------------

/**
 * Unified render context. Scope-aware: `challenge` is present only for
 * challenge-scoped runs; `instruction` only for event-scoped (scheduler) runs.
 * `agent` and `capabilities` are per-agent — filled when the system renders
 * that agent's system prompt (capabilities derived from the agent's tools).
 * Field names match the built-in handlebars templates.
 */
export type PromptContext = {
  event: {
    id: string
    name: string
    platform: string | null
    promptHint: string
  }
  challenge?: {
    id: string
    name: string
    description: string
    category: string | null
    points: number | null
    attachments: PromptAttachment[]
    attachmentPaths: string[]
  }
  agent?: {
    role: string
    isMain: boolean
    name: string
    task: string | null
    isEntry?: boolean
  }
  model?: {
    provider: string
    name: string
    id: string
  }
  run?: {
    id: string
    environment: "container"
    isContainer: true
    workspace: string
    targetSupported: boolean
    platformIntegrated: boolean
    containerImage: string
    cpus: number
    memoryMb: number
    pidsLimit: number
    /** v9: true when the run has more than one solver — renders the
     * shared-workspace collaboration section in `mainSystem`. */
    multiSolver: boolean
  }
  capabilities?: Capabilities
  /** event-scoped only (scheduler instruction). */
  instruction?: string
  /** challenge-scope initial only: the per-run strategy appended as a
   * `## Strategy` section (queue/scheduler `prompt` override). Injected by
   * the run factory when a strategy was supplied; the standard blocks
   * (challenge, environment, submission) are always rendered. */
  strategy?: string
}

// --- event-scope (scheduler wake-up) events -------------------------------

export type EventScopeEvent =
  | "run.started"
  | "run.idle"
  | "run.flagAccepted"
  | "run.finished"
  | "run.timedOut"
  | "run.resumed"

export type EventScopePayload =
  | {
      type: "run.started"
      runId: string
      agentId?: string
      source?: "manual" | "scheduler"
    }
  | {
      type: "run.idle"
      runId: string
      agentId?: string
      failed?: boolean
      source?: "manual" | "scheduler"
    }
  | {
      type: "run.flagAccepted"
      runId: string
      agentId?: string
      source?: "manual" | "scheduler"
    }
  | {
      type: "run.finished"
      runId: string
      agentId?: string
      source?: "manual" | "scheduler"
    }
  | {
      type: "run.timedOut"
      runId: string
      outcome: "idle" | "closed"
      source?: "manual" | "scheduler"
    }
  | {
      type: "run.resumed"
      runId: string
      agentId?: string
      source?: "manual" | "scheduler"
    }
