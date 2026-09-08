import type { PromptAttachment } from "@aegisx/shared"

// --- per-agent capabilities (derived from the agent's tool list) -----------

/** Per-agent capability flags. Derived from the agent's `tools` array,
 * NOT from the challenge — so each agent's rendered system
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
 * Unified render context. Scope-aware: `challenge` + `workspace` are present
 * only for solver agents; `instruction` only for the scheduler agent.
 * `capabilities` are derived from the agent's tools at spawn time. Field
 * names match the built-in handlebars templates.
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
    /** Whether the challenge is bound to an integrated remote platform
     * (flag verification semantics: remote judge vs local accept). */
    integrated?: boolean
    attachments: PromptAttachment[]
    attachmentPaths: string[]
    /** Accepted multi-flag values at spawn time (live progress — the
     * description's count is a sync-time snapshot). */
    confirmedFlags?: string[]
  }
  agent?: {
    role: "solver" | "orchestrator"
    name: string
  }
  model?: {
    provider: string
    name: string
    id: string
  }
  workspace?: {
    root: string
    /** Solver-context extras; the scheduler context carries only the root. */
    agentDir?: string
    sharedDir?: string
    attachmentsDir?: string
    siblingsDir?: string
    containerImage?: string
    cpus?: number
    memoryMb?: number
    pidsLimit?: number
  }
  capabilities?: Capabilities
  /** event-scope only (scheduler instruction). */
  instruction?: string
  /** solver initial only: the spawn prompt appended as a `## Strategy`
   * section. Injected by the agent factory when a prompt was supplied; the
   * standard blocks (challenge, environment, submission) are always
   * rendered. */
  strategy?: string
}

// --- scheduler wake-up events (v19: agent-scoped) --------------------------

export type EventScopePayload =
  | {
      type: "agent.started"
      agentId: string
      source?: "manual" | "scheduler"
    }
  | {
      type: "agent.idle"
      agentId: string
      failed?: boolean
      source?: "manual" | "scheduler"
    }
  | {
      type: "agent.flagAccepted"
      agentId: string
      source?: "manual" | "scheduler"
    }
  | {
      type: "agent.finished"
      agentId: string
      source?: "manual" | "scheduler"
      /** Who drove the finish (user vs the scheduler's SDK call). */
      actor?: "user" | "scheduler"
    }
  | {
      type: "agent.timedOut"
      agentId: string
      outcome: "idle" | "aborted"
      source?: "manual" | "scheduler"
    }
  | {
      type: "agent.reopened"
      agentId: string
      source?: "manual" | "scheduler"
    }
