export type {
  AgentInspector,
  AgentPublic,
  AgentRuntimeSnapshot,
  AgentStatus,
  AgentSummary,
  AgentToolStats,
  AssistantMessage,
  Attachment,
  Challenge,
  ChallengeInput,
  ChallengeSyncAttachment,
  ChallengeSyncItem,
  ChallengeSyncProgress,
  ChallengeSyncResult,
  ConversationToolExpandPrefs,
  EventInput,
  EventPlatform,
  EventStats,
  EventSummary,
  FlatSettings,
  LiveEvent,
  Message,
  MessagesPage,
  ModelMetadata,
  NoticeMessage,
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
  SettingDef,
  SettingGroup,
  SettingKey,
  SettingWidget,
  TargetState,
  ThinkingLevel,
  ToolResultMessage,
  UsageSummary,
  UserMessage,
} from "../../../shared"

export {
  conversationToolExpand,
  defaultSettings,
  get,
  isMessage,
  isSettingModified,
  SETTINGS_DEFS,
  settingDef,
} from "../../../shared"

import type { FlatSettings } from "../../../shared"

export type SettingsResponse = {
  settings: FlatSettings
  updatedAt: string
  meta: {
    promptDefaults: {
      "prompts.mainSystem": string
      "prompts.childSystem": string
      "prompts.initial": string
    }
    promptVariables: string[]
  }
}

import type { Message } from "../../../shared"

/** Agent message page from REST. */
export type AgentMessages = {
  runId: string
  agentId: string
  messages: Message[]
}
