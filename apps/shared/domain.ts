export type PlatformType =
  | "ctfd"
  | "ret2shell"
  | "a1ctf"
  | "tsecbench"
  | "dasctf"

export type ProviderType =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-messages"

export type RemoteEvent = { id: string; name: string }

export type RemoteChallengeSummary = {
  id: string
  name: string
  category: string | null
  points: number | null
  solved: boolean
  imported: boolean
  localChallengeId: string | null
}

export type ChallengeSyncAttachment = {
  filename: string
  size: number
  status: "downloaded" | "updated"
}

export type ChallengeSyncItem = {
  remoteId: string
  status: "created" | "updated" | "failed"
  challengeId?: string
  error?: string
  name?: string
  category?: string | null
  points?: number | null
  attachments?: ChallengeSyncAttachment[]
}

export type ChallengeSyncProgress = {
  remoteId: string
  phase: "fetching" | "metadata" | "attachment"
  message: string
  name?: string
  category?: string | null
  points?: number | null
  attachment?: {
    filename: string
    index: number
    total: number
  }
}

export type ChallengeSyncResult = {
  syncedAt: string
  results: ChallengeSyncItem[]
}

export type EventPlatform = {
  eventId: string
  type: PlatformType
  baseUrl: string
  credential: string
  remoteEventId: string
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
  credentialConfigured: boolean
}

export type SubmissionStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "partial"
  | "already_solved"
  | "rate_limited"
  | "error"
import type { ThinkingLevel } from "./live-event"

export type PiModelProfile = {
  providerId: string
  modelId: string
  name: string
}

export type ModelMetadata = {
  reasoning: boolean
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>
  input: Array<"text" | "image">
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    tiers?: Array<{
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      inputTokensAbove: number
    }>
  }
  costKnown: boolean
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}

export type ProviderModel = {
  id: string
  providerId: string
  modelId: string
  label: string
  enabled: boolean
  metadata: ModelMetadata
  piBinding: { providerId: string; modelId: string } | null
  thinkingLevels: ThinkingLevel[]
  createdAt: string
  updatedAt: string
}

export type ProviderConnection = {
  id: string
  label: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  models: ProviderModel[]
}
export type EventInput = {
  name: string
  promptHint?: string
}

export type EventSummary = {
  id: string
  name: string
  promptHint: string
  platform: EventPlatform | null
  createdAt: string
  updatedAt: string
  challengeCount: number
  solvedCount: number
  activeAgentCount: number
  lastActivityAt: string
}
export type TargetEndpointProtocol =
  | "http"
  | "https"
  | "ws"
  | "wss"
  | "tcp"
  | "udp"

export type TargetEndpoint = {
  name: string
  address: string
  protocol: TargetEndpointProtocol
  guidance?: string[]
}

export type TargetStatus =
  | "absent"
  | "starting"
  | "running"
  | "stopping"
  | "failed"

export type TargetState = {
  status: TargetStatus
  endpoints: TargetEndpoint[]
  expiresAt: string | null
  message?: string
}

export function isActiveTarget(target: TargetState): boolean {
  return (
    target.status === "starting" ||
    target.status === "running" ||
    target.status === "stopping"
  )
}

export type RemoteTargetInfo = {
  name: string
  services: string[]
}
import type { AgentStatus } from "./agent"

export type Attachment = {
  id: string
  challengeId: string
  originalName: string
  size: number
  sha256: string
  createdAt: string
  downloadUrl: string
}

export type ChallengeInput = {
  name: string
  description: string
  category: string | null
  points: number | null
}

/** Per-dimension solve state. `solved` > `partial` > `unsolved`. */
export type SolveState = "solved" | "partial" | "unsolved"

/** A recorded flag for a challenge (one-to-many — 一题多解). */
export type ChallengeFlag = {
  id: string
  challengeId: string
  flag: string
  status: "pending" | "accepted" | "rejected" | "error"
  source: "agent" | "manual"
  agentId: string | null
  remoteId: string | null
  message: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Solve state split into three independent dimensions, merged by priority
 * `manual > remote > local` (first non-`unsolved` wins):
 *  - `local`: derived — `accepted` iff an accepted flag exists, else `unsolved`.
 *  - `manual`: user-assigned override (stored on `challenges.manual_solve_state`).
 *  - `remote`: platform verdict (`challenge_remote.solved` mapped to solved/unsolved).
 */
export type ChallengeSolved = {
  local: SolveState
  manual: SolveState
  remote: SolveState
}

export type Challenge = {
  id: string
  eventId: string
  name: string
  description: string
  category: string | null
  points: number | null
  createdAt: string
  updatedAt: string
  attachments: Attachment[]
  flags: ChallengeFlag[]
  solved: ChallengeSolved
  agentCount: number
  agentStatusCounts: Partial<Record<AgentStatus, number>>
  remoteId: string | null
  remoteAvailable: boolean
  remoteTarget: boolean
  remoteTargetIgnored: boolean
  remoteTargetCount: number
  targets: RemoteTargetInfo[]
  remoteUpdatedAt: string | null
}
