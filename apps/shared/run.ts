import type { AgentSummary } from "./agent"
import type { ChallengeFlag } from "./challenge"
import type { RunStatus } from "./run-status"
import type { ThinkingLevel } from "./thinking"

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
 * (orchestration='scheduler') that manages a task queue for an event. */
export type RunScope = "challenge" | "event"

export type RunSource = "manual" | "scheduler"

export type RunPublic = {
  id: string
  scopeType: RunScope
  eventId: string
  /** Nullable: event-scope (scheduler) runs have no challenge. */
  challengeId: string | null
  challengeName: string
  /** Orchestration plugin id (e.g. 'classic', 'scheduler'). */
  orchestration: string
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
