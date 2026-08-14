export type {
  AgentStatus,
  AgentSummary,
  Attachment,
  Challenge,
  ChallengeFlag,
  ChallengeInput,
  ChallengeSolved,
  ChallengeSyncAttachment,
  ChallengeSyncItem,
  ChallengeSyncProgress,
  ChallengeSyncResult,
  CompactionEntry,
  EntryItem,
  EventInput,
  EventPlatform,
  EventSummary,
  FlatSettings,
  LiveEvent,
  MessageList,
  MessageListItem,
  ModelAlias,
  ModelRef,
  ModelMetadata,
  PiModelProfile,
  PlatformType,
  ProviderConnection,
  ProviderModel,
  ProviderType,
  RemoteChallengeSummary,
  RemoteEvent,
  RunDetail,
  RunFile,
  RunFileEntry,
  RunPublic,
  RunStatus,
  RunUsage,
  SessionEntry,
  SessionMessageEntry,
  SettingDef,
  SettingGroup,
  SettingKey,
  SettingWidget,
  SolveState,
  SwitchModelInput,
  TargetState,
  ThinkingLevel,
  TimingBlock,
  TimingMeta,
} from "@aegisx/shared"
export {
  defaultSettings,
  get,
  isSessionEntry,
  isSettingModified,
  isTimingMeta,
  SETTINGS_DEFS,
  settingDef,
} from "@aegisx/shared"

export type {
  CompactionReason,
  ContextSnapshot,
} from "@aegisx/shared/live-event"

import type { FlatSettings } from "@aegisx/shared"

import type { RunPublic } from "./types"

/** Task-queue item (mirrors the server's QueueItemPublic). */
export type QueueItem = {
  id: string
  eventId: string
  ord: number
  challengeId: string
  challengeName: string
  orchestration: string
  params: Record<string, unknown>
  timeoutMs: number | null
  prompt: string
  source: "manual" | "scheduler"
  status: "pending" | "running" | "done" | "cancelled" | "failed"
  runId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** GET /api/events/:id/scheduler — config + run + fence status snapshot. */
export type SchedulerInfo = {
  config: {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
  }
  run: RunPublic | null
  status: {
    maxConcurrentRuns: number
    runningCount: number
    maxConcurrentTargets: number
    activeTargetChallenges: string[]
    activeRuns: Array<{
      id: string
      challengeId: string | null
      challengeName: string
      status: string
      orchestration: string
    }>
  }
}

/** GET /api/orchestrations — plugin id/scope + declared slots + templates. */
export type OrchestrationInfo = {
  id: string
  scope: "challenge" | "event"
  label: string
  description: string
  agents: Array<{
    slot: string
    role: string
    name: string
    entry: boolean
  }>
  templates: Record<string, string>
  templateKeys: string[]
}

/** GET/PATCH /api/prompt-templates — one row of the template store (spec §3.6). */
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
      childSystem: string
      initial: string
      orchestratorSystem: string
    }
    promptVariables: string[]
    orchestratorPromptVariables: string[]
  }
}
