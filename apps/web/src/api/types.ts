export type {
  AgentSessionSummary,
  AgentStatus,
  AgentSummary,
  Attachment,
  Challenge,
  ChallengeFlag,
  ChallengeInput,
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
  SettingKey,
  SolveState,
  SwitchModelInput,
  TargetState,
  ThinkingLevel,
  TimingBlock,
  TimingMeta,
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

import type { RunPublic } from "./types"

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
  runId: string | null
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

/** GET /api/events/:id/inbox — live scheduler-inbox snapshot. */
export type InboxSnapshot = {
  live: boolean
  deliveryPaused: boolean
  pending: Array<{ runId: string; events: string[] }>
  notices: string[]
  emergency: string[]
  silence: { armed: boolean; flushAt: number | null }
  stallWatch: Array<{ runId: string; dueAt: number }>
}

/** One delivered digest row (GET /api/events/:id/inbox/digests). */
export type InboxDigest = {
  id: string
  eventId: string
  text: string
  createdAt: string
}

/** GET /api/events/:id/inbox/digests — newest first, offset pagination. */
export type InboxHistory = {
  items: InboxDigest[]
  total: number
  hasMore: boolean
}

/** GET /api/events/:id/scheduler — config + run + fence status snapshot. */
export type SchedulerInfo = {
  config: {
    eventId: string
    modelId: string | null
    instruction: string
    maxConcurrentTargets: number
    /** W3: scheduler disabled (run-lifecycle events gated). */
    paused: boolean
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
    }>
  }
}

/** W7.3: GET /api/events/:id/fleet — the overview's single poll (runs +
 * agents + scheduler run/agents + scheduler config/status). */
export type FleetInfo = {
  runs: RunPublic[]
  agentsByRun: Record<string, AgentSummary[]>
  schedulerRun: RunPublic | null
  schedulerAgents: AgentSummary[]
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
    }
    promptVariables: string[]
    orchestratorPromptVariables: string[]
  }
}
