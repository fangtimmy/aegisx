export {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
} from "./prompt-defaults"
export type {
  ConfigDocumentV1,
  FlatSettings,
  SettingDef,
  SettingGroup,
  SettingKey,
  SettingWidget,
} from "./settings-schema"
export {
  CONFIG_DOCUMENT_VERSION,
  defaultSettings,
  extractLegacyPromptTemplates,
  get,
  isConfigDocumentV1,
  isSettingKey,
  isSettingModified,
  migrateLegacySettings,
  modifiedSettingKeys,
  parseSettings,
  patchSettings,
  SETTING_KEYS,
  SETTINGS_DEFS,
  settingDef,
} from "./settings-schema"
