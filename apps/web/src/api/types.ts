export type {
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
