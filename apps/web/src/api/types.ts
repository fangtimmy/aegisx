export type {
  AgentRole,
  AgentStatus,
  AgentSummary,
  AssistantMessage,
  Attachment,
  Challenge,
  ChallengeInput,
  ChallengeSyncAttachment,
  ChallengeSyncItem,
  ChallengeSyncProgress,
  ChallengeSyncResult,
  EventInput,
  EventPlatform,
  EventSummary,
  FlatSettings,
  ImageContent,
  LiveEvent,
  Message,
  MessageList,
  MessageRole,
  ModelMetadata,
  NoticeMessage,
  NoticeSystemKind,
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
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "../../../shared"
export {
  defaultSettings,
  get,
  isMessage,
  isSettingModified,
  SETTINGS_DEFS,
  settingDef,
} from "../../../shared"

export type {
  CompactionReason,
  ContextSnapshot,
} from "../../../shared/live-event"

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
