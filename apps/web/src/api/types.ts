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
  TargetState,
  ThinkingLevel,
} from "../../../shared"
export {
  defaultSettings,
  get,
  isSessionEntry,
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
