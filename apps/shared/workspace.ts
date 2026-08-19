import type { ThinkingLevel } from "./live-event"

/** Aggregated token usage + cost across an agent's assistant messages.
 * `turns` is the number of assistant messages that reported usage. */
export type AgentUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  totalTokens: number
  cost: number
  turns: number
}

/** One workspace tree entry (GET /api/challenges/:id/files). */
export type WorkspaceFileEntry = {
  name: string
  path: string
  type: "file" | "directory"
  size: number
  modifiedAt: string
}

export type WorkspaceFile =
  | {
      path: string
      type: "directory"
      entries: WorkspaceFileEntry[]
    }
  | {
      path: string
      type: "text"
      size: number
      modifiedAt: string
      content: string
      truncated: boolean
    }
  | {
      path: string
      type: "binary"
      size: number
      modifiedAt: string
    }

/** The workspace block of an agent's environment (challenge workspaces and
 * the scheduler workspace alike share this shape). Derived from the global
 * container settings at spawn time — never snapshotted to a row. */
export type WorkspaceInfo = {
  containerRunning: boolean
  liveAgentCount: number
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
}

/** v3+ is container-only; every agent runs in a Docker container. */
export type EnvironmentConfig = {
  type: "container"
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
}

export type ModelConfig = {
  provider: string
  providerLabel?: string
  modelId: string
  modelLabel?: string
  baseUrl?: string
  costKnown?: boolean
  thinkingLevel: ThinkingLevel
}

export type PromptAttachment = {
  name: string
  path: string
  size: number
}

/**
 * Prompt template context (handlebars). v19: the workspace is a derived path
 * tree — the agent's own directory (`agents/<id8>`), the read-only `shared/`
 * area the server writes into, `attachments/`, and sibling agent dirs.
 */
export type PromptTemplateContext = {
  agent: {
    role: "solver" | "orchestrator"
    name: string
  }
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
    /** Bound to an integrated remote platform (verifies flags remotely)?
     * Absent/false → submitted flags are accepted locally. */
    integrated?: boolean
    attachments: PromptAttachment[]
    attachmentPaths: string[]
  }
  model: {
    provider: string
    name: string
    id: string
  }
  workspace?: {
    /** Container-internal workspace root (the container.workspace setting). */
    root: string
    /** This agent's own directory, workspace-relative (`agents/<id8>`). */
    agentDir: string
    /** Server-written, agent-read-only shared area (`shared`). */
    sharedDir: string
    /** Challenge attachments materialized once per workspace (`attachments`). */
    attachmentsDir: string
    /** Sibling agent directories (`agents`). */
    siblingsDir: string
    containerImage: string
    cpus: number
    memoryMb: number
    pidsLimit: number
  }
  capabilities: {
    canFinish: boolean
    canSubmitFlag: boolean
    canManageTarget: boolean
  }
  /** event-scope only (scheduler instruction). */
  instruction?: string
  /** challenge-scope initial only: the spawn prompt appended as a
   * `## Strategy` section. */
  strategy?: string
}
