export type {
  AgentDetail,
  AgentSessionSummary,
  AgentStatus,
  AgentSummary,
  AgentUsage,
  Attachment,
  Challenge,
  ChallengeFlag,
  ChallengeInput,
  ChallengeSyncItem,
  ChallengeSyncProgress,
  ChallengeSyncResult,
  ChannelMessageList,
  ChannelMessagePublic,
  ChannelPublic,
  CompactionEntry,
  EntryItem,
  EventInput,
  EventPlatform,
  EventSummary,
  FlatSettings,
  InboxSnapshot,
  LiveEvent,
  MessageList,
  MessageListItem,
  ModelOption,
  ModelRef,
  ModelMetadata,
  PiModelProfile,
  PlatformType,
  ProviderConnection,
  ProviderModel,
  ProviderType,
  RemoteChallengeSummary,
  RemoteEvent,
  SessionEntry,
  SessionMessageEntry,
  SettingDef,
  SettingKey,
  SolveState,
  SwitchModelInput,
  TargetState,
  TimingBlock,
  TimingMeta,
  WorkspaceFile,
  WorkspaceFileEntry,
} from "@aegisx/shared"
export {
  isSessionEntry,
  isSettingModified,
  isTimingMeta,
  SETTINGS_DEFS,
} from "@aegisx/shared"

export type { ContextSnapshot } from "@aegisx/shared/live-event"

import type { FlatSettings } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"

/** Task-queue item (mirrors the server's QueueItemPublic). */
export type QueueItem = {
  id: string
  eventId: string
  ord: number
  challengeId: string
  challengeName: string
  params: Record<string, unknown>
  timeoutMs: number | null
  prompt: string
  source: "manual" | "scheduler"
  status: "pending" | "running" | "done" | "cancelled" | "failed"
  agentId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** Per-event queue state (absent row = running). */
export type QueueState = "running" | "paused"

/** GET /api/events/:id/queue — items + the event's queue state. */
export type QueueSnapshot = {
  items: QueueItem[]
  state: QueueState
}

/** GET /api/events/:id/scheduler — config + the scheduler agent + fence
 * status snapshot. */
export type SchedulerInfo = {
  config: {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
    /** W3: scheduler disabled (agent-lifecycle events gated). */
    paused: boolean
    notifyTeamOnFlag: boolean
    stopSiblingsOnSolve: boolean
    stopTargetOnSolve: boolean
    nextTaskPolicy: "eager" | "drained"
    urgentTeamMessages: boolean
    /** A fully-solved challenge rejects new spawns while true. */
    blockSpawnOnSolved: boolean
  }
  agent: AgentSummary | null
  status: {
    maxConcurrentAgents: number
    liveAgentCount: number
    maxConcurrentTargets: number
    nextTaskPolicy: "eager" | "drained"
    activeTargetChallenges: string[]
    activeAgents: Array<{
      id: string
      challengeId: string | null
      challengeName: string
      status: string
    }>
  }
}

/** GET /api/events/:id/fleet — the overview's single poll (challenges +
 * per-challenge agents + the scheduler agent + scheduler config/status). */
export type FleetInfo = {
  challenges: { id: string; name: string; category: string | null }[]
  agentsByChallenge: Record<string, AgentSummary[]>
  schedulerAgent: AgentSummary | null
  config: SchedulerInfo["config"]
  status: SchedulerInfo["status"]
}

/** GET/PATCH /api/prompt-templates — one row of the template store. */
export type PromptTemplateRow = {
  plugin: string
  key: string
  body: string
  updatedAt: string
}

export type SettingsResponse = {
  settings: FlatSettings
  updatedAt: string
  meta: {
    /** Builtin template defaults, keyed by template key (reset source). */
    promptTemplateDefaults: {
      mainSystem: string
      initial: string
      orchestratorSystem: string
      schedulerInitial: string
      channelDelivery: string
      schedulerDigest: string
    }
    promptVariables: string[]
    orchestratorPromptVariables: string[]
    deliveryPromptVariables: string[]
    schedulerDigestVariables: string[]
  }
}
