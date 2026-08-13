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
} from "@aegisx/shared"
export {
  defaultSettings,
  get,
  isSessionEntry,
  isSettingModified,
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

export type SettingsResponse = {
  settings: FlatSettings
  updatedAt: string
  meta: {
    promptDefaults: {
      "prompts.mainSystem": string
      "prompts.childSystem": string
      "prompts.initial": string
      "prompts.orchestratorSystem": string
    }
    promptVariables: string[]
    orchestratorPromptVariables: string[]
  }
}
