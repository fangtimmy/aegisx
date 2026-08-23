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
  FleetInfo,
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
  QueueSnapshot,
  QueueState,
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

import type {
  FlatSettings,
  FleetInfo,
  QueueItemPublic,
  SchedulerStatusSnapshot,
} from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"

/** Task-queue item — the shared canonical row (QueueItemPublic). */
export type QueueItem = QueueItemPublic

/** GET /api/events/:id/scheduler — config + the scheduler agent + fence
 * status snapshot. */
export type SchedulerInfo = {
  config: FleetInfo["config"]
  agent: AgentSummary | null
  status: SchedulerStatusSnapshot
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
