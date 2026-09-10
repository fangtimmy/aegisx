import type { ChallengeProgress } from "./progress"

/** Canonical platform / provider kind lists — the TS unions and the TypeBox
 * wire schemas are both derived from these tuples. */
export const PLATFORM_TYPES = [
  "ctfd",
  "ret2shell",
  "a1ctf",
  "tsecbench",
  "dasctf",
] as const
export type PlatformType = (typeof PLATFORM_TYPES)[number]

export const PROVIDER_TYPES = [
  "openai-compatible",
  "openai-responses",
  "anthropic-messages",
] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

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

/** Per-agent lifecycle. Solver + orchestrator agents use running|idle
 * (turn-by-turn); terminal states keep the DB session + files for reopen. */
export type AgentStatus =
  | "running"
  | "idle"
  | "completed"
  | "aborted"
  | "failed"

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    value === "running" ||
    value === "idle" ||
    value === "completed" ||
    value === "aborted" ||
    value === "failed"
  )
}

/** An agent holds live resources (a session; the challenge workspace's
 * container is shared and lazily managed). */
export const LIVE_AGENT_STATUSES: AgentStatus[] = ["running", "idle"]

export function isActiveAgentStatus(status: string): boolean {
  return LIVE_AGENT_STATUSES.some((live) => live === status)
}

export function isTerminalAgentStatus(status: string): boolean {
  return status === "completed" || status === "aborted" || status === "failed"
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}

export type PiModelProfile = {
  providerId: string
  modelId: string
  name: string
  metadata: ModelMetadata
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
  /** Metadata provenance, e.g. `"pi:anthropic/claude-sonnet-4-5"` when the
   * metadata was copied from pi's builtin catalog (re-importing refreshes
   * it). Null = hand-written. */
  metadataSource: string | null
  thinkingLevels: ThinkingLevel[]
}

export type ProviderConnection = {
  id: string
  label: string
  type: ProviderType
  baseUrl: string
  /** Exact-endpoint gateway: baseUrl already carries the full upstream path
   * (e.g. a CTF LLM gateway whose token encodes the complete URL), so no API
   * suffix (/responses, /chat/completions, /v1/messages) may be appended —
   * traffic rides the server's /api/llm-relay route instead. */
  exactEndpoint: boolean
  apiKey: string
  enabled: boolean
  models: ProviderModel[]
}

/** GET /api/models item — one currently-selectable model (enabled provider ×
 * enabled model), with the canonical address ref selectors key on. */
export type ModelOption = {
  /** Canonical address (`aegisx-<providerId>/<modelId>`, no effort). */
  address: string
  label: string
  providerLabel: string
  thinkingLevels: ThinkingLevel[]
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
type TargetEndpointProtocol = "http" | "https" | "ws" | "wss" | "tcp" | "udp"

export type TargetEndpoint = {
  name: string
  address: string
  protocol: TargetEndpointProtocol
  guidance?: string[]
}

type TargetStatus = "absent" | "starting" | "running" | "stopping" | "failed"

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
 *  - `local`: derived from the accepted flag rows. `solved` when the local
 *    record settles the challenge (no platform verdict to wait on, or the
 *    platform already reported it solved); `partial` while a platform-
 *    integrated challenge still owns flags it has not confirmed (an accepted
 *    row can be a multi-flag partial); `unsolved` with no accepted flag.
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
  /** The authoritative derived progress (state / confirmed / required / yield)
   * from `progressOf`. `solved` stays the three raw dimensions for display;
   * this is what decisions read. */
  progress: ChallengeProgress
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
