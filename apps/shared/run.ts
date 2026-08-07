import type { AgentSummary } from "./agent"
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

export type RunPublic = {
  id: string
  challengeId: string
  challengeName: string
  eventId: string
  status: RunStatus
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
  error: string | null
  summary: string | null
  flag: string | null
  hasFlag: boolean
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
