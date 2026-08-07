export type {
  AgentRole,
  AgentStatus,
  AgentSummary,
  Attachment,
  Challenge,
  ChallengeInput,
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
  OrchestratorConfigInput,
  OrchestratorDetail,
  OrchestratorPublic,
  OrchestratorStatus,
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
