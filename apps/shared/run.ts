import type { AgentSummary } from "./agent"
import type { ChallengeFlag } from "./domain"
import type { ThinkingLevel } from "./live-event"

/** Aggregated token usage + cost across a run's assistant messages. `turns` is
 * the number of assistant messages that reported usage. */
export type RunUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  totalTokens: number
  cost: number
  turns: number
}

/** 'challenge' = a solver run on one challenge; 'event' = the scheduler run
 * (scopeType='event') that manages a task queue for an event. */
export type RunScope = "challenge" | "event"

export type RunSource = "manual" | "scheduler"

/** One solver's creation spec (v9). Array length = the run's solver count. */
export type SolverSpec = {
  /** Canonical model ref; omit = the global default model. */
  model?: string
  /** This solver's own prompt. */
  prompt?: string
  /** 'strategy' (default) renders the `initial` template with the prompt
   * appended to the run-level Strategy section; 'override' replaces the
   * initial prompt entirely (first turn = the raw prompt). */
  promptMode?: "strategy" | "override"
}

export type RunPublic = {
  id: string
  scopeType: RunScope
  eventId: string
  /** Nullable: event-scope (scheduler) runs have no challenge. */
  challengeId: string | null
  challengeName: string
  status: RunStatus
  /** Set atomically by finish_run; the winning agent tears the run down. */
  finishing: boolean
  source: RunSource
  targetSupported: boolean
  provider: string
  modelId: string
  modelName: string
  thinkingLevel: ThinkingLevel
  environment: "container"
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  containerName: string
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  /** When the hard deadline last fired (abort branch); null until the first
   * timeout. Timeline source (spec §十一: run.timedOut{outcome}). */
  lastTimeoutAt: string | null
  error: string | null
  summary: string | null
  flags: ChallengeFlag[]
  hasAcceptedFlag: boolean
  usage?: RunUsage
}

/** REST snapshot for a run, including its main + child agents. */
export type RunDetail = {
  run: RunPublic
  agents: AgentSummary[]
}

export type RunFileEntry = {
  name: string
  path: string
  type: "file" | "directory"
  size: number
  modifiedAt: string
}

export type RunFile =
  | {
      path: string
      type: "directory"
      entries: RunFileEntry[]
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

/** v3 is container-only; every run is a Docker container running pi. */
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
 * Prompt template context (handlebars). v4 renders these host-side and feeds
 * them to the pi SDK via a custom ResourceLoader (no APPEND_SYSTEM.md in the
 * container). The main agent can spawn children; capabilities reflect the
 * native tools registered for the run.
 */
export type PromptTemplateContext = {
  agent: {
    role: "main" | "child"
    isMain: boolean
    name: string
    task: string | null
  }
  event: {
    id: string
    name: string
    platform: string | null
    promptHint: string
  }
  challenge: {
    id: string
    name: string
    description: string
    category: string | null
    points: number | null
    attachments: PromptAttachment[]
    attachmentPaths: string[]
  }
  model: {
    provider: string
    name: string
    id: string
  }
  run: {
    id: string
    /** v3 is container-only — every run runs in a Docker container. */
    environment: "container"
    isContainer: true
    workspace: string
    targetSupported: boolean
    platformIntegrated: boolean
    containerImage: string
    cpus: number
    memoryMb: number
    pidsLimit: number
    /** v9: true when the run has more than one solver. */
    multiSolver: boolean
  }
  capabilities: {
    canFinish: boolean
    canSubmitFlag: boolean
    canManageTarget: boolean
  }
}

/** Run lifecycle. A run's status is SQL-derived from its agents' statuses
 * (running ↔ idle) plus sanctioned explicit `closed` transitions
 * (finish / close / timeout-SIGKILL / recoverOnBoot). Not a dead terminal:
 * the DB session + agent rows survive a `closed` run for cold-restore. */
export type RunStatus = "running" | "idle" | "closed"

/** A run holds live resources (container + in-process sessions). */
export function isActiveRunStatus(status: string): boolean {
  return status === "running" || status === "idle"
}

/** Per-agent lifecycle. Solver + orchestrator agents use running|idle
 * (turn-by-turn); `aborted` is set when the run is torn down
 * (finish/close/timeout) while the agent was mid-turn. */
export type AgentStatus =
  | "running"
  | "idle"
  | "completed"
  | "aborted"
  | "failed"
