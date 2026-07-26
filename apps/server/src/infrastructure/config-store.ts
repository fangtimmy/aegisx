import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { type Static, Type } from "typebox"
import { Value } from "typebox/value"
import type {
  Environment,
  ProviderType,
  SettingsPublic,
  ThinkingLevel,
} from "../../../shared"
import {
  EnvironmentSchema,
  ProviderTypeSchema,
  ThinkingLevelSchema,
} from "../lib/schemas"

export type { Environment, ProviderType, SettingsPublic, ThinkingLevel }

export type ProviderModelData = {
  id: string
  modelId: string
  label: string
  enabled: boolean
  metadata: string
  piProviderId: string | null
  piModelId: string | null
}

export type ProviderData = {
  id: string
  label: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: ProviderModelData[]
}

export type ConfigData = {
  settings: SettingsPublic
  providers: ProviderData[]
}

const now = () => new Date().toISOString()

export const defaultToolTimeouts: Record<string, number> = {
  bash: 120_000,
  submit_flag: 90_000,
  get_target: 30_000,
  start_target: 120_000,
  extend_target: 30_000,
  stop_target: 30_000,
}

export const defaultConversationToolExpand: SettingsPublic["conversationToolExpand"] =
  {
    fileRead: false,
    fileEdit: false,
    bash: false,
    target: false,
    flag: false,
    agent: false,
    errors: false,
  }

export const defaultSettings: SettingsPublic = {
  defaultModelId: null,
  defaultThinkingLevel: "off",
  environment: "local",
  containerImage: "alpine:3.22",
  cpus: 2,
  memoryMb: 2048,
  pidsLimit: 256,
  maxConcurrency: 2,
  maxAttachmentMb: 512,
  mainSystemPromptTemplate: "",
  childSystemPromptTemplate: "",
  initialPromptTemplate: "",
  maxRetryAttempts: 3,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 30_000,
  maxToolOutputBytes: 64_000,
  maxInlineShellOutputBytes: 12_000,
  maxCapturedShellOutputBytes: 1_000_000,
  containerWorkspace: "/workspace",
  dockerTimeoutMs: 30_000,
  tmpfsSize: "64m",
  platformRequestTimeoutMs: 30_000,
  providerDiscoverTimeoutMs: 10_000,
  defaultToolTimeoutMs: 30_000,
  toolTimeouts: { ...defaultToolTimeouts },
  renderUserMessagesAsMarkdown: false,
  renderReasoningAsMarkdown: false,
  conversationToolExpand: { ...defaultConversationToolExpand },
  // Derived display-only fields; populated for type completeness.
  defaultMainSystemPromptTemplate: "",
  defaultChildSystemPromptTemplate: "",
  defaultInitialPromptTemplate: "",
  promptTemplateVariables: [],
  updatedAt: "",
}

const SettingsSchema = Type.Object(
  {
    defaultModelId: Type.Union([Type.String(), Type.Null()]),
    defaultThinkingLevel: ThinkingLevelSchema,
    environment: EnvironmentSchema,
    containerImage: Type.String(),
    cpus: Type.Number(),
    memoryMb: Type.Number(),
    pidsLimit: Type.Number(),
    maxConcurrency: Type.Number(),
    maxAttachmentMb: Type.Number(),
    mainSystemPromptTemplate: Type.String(),
    childSystemPromptTemplate: Type.String(),
    initialPromptTemplate: Type.String(),
    maxRetryAttempts: Type.Number(),
    retryBaseDelayMs: Type.Number(),
    retryMaxDelayMs: Type.Number(),
    maxToolOutputBytes: Type.Number(),
    maxInlineShellOutputBytes: Type.Number(),
    maxCapturedShellOutputBytes: Type.Number(),
    containerWorkspace: Type.String(),
    dockerTimeoutMs: Type.Number(),
    tmpfsSize: Type.String(),
    platformRequestTimeoutMs: Type.Number(),
    providerDiscoverTimeoutMs: Type.Number(),
    defaultToolTimeoutMs: Type.Number(),
    toolTimeouts: Type.Record(Type.String(), Type.Number()),
    renderUserMessagesAsMarkdown: Type.Boolean(),
    renderReasoningAsMarkdown: Type.Boolean(),
    conversationToolExpand: Type.Optional(
      Type.Object(
        {
          fileRead: Type.Boolean(),
          fileEdit: Type.Boolean(),
          bash: Type.Boolean(),
          target: Type.Boolean(),
          flag: Type.Boolean(),
          agent: Type.Boolean(),
          errors: Type.Boolean(),
        },
        { additionalProperties: false }
      )
    ),
    updatedAt: Type.String(),
  },
  { additionalProperties: true }
)

const ProviderModelSchema = Type.Object(
  {
    id: Type.String(),
    modelId: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    metadata: Type.Optional(Type.String()),
    piProviderId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    piModelId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true }
)

const ProviderSchema = Type.Object(
  {
    id: Type.String(),
    label: Type.Optional(Type.String()),
    type: ProviderTypeSchema,
    baseUrl: Type.Optional(Type.String()),
    apiKey: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    models: Type.Optional(Type.Array(ProviderModelSchema)),
  },
  { additionalProperties: true }
)

function defaultProviders(): ProviderData[] {
  return [
    {
      id: "default-provider",
      label: "Anthropic",
      type: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      enabled: true,
      models: [
        {
          id: "default-model",
          modelId: "claude-sonnet-4-5",
          label: "Claude Sonnet 4.5",
          enabled: true,
          metadata: "{}",
          piProviderId: null,
          piModelId: null,
        },
      ],
    },
  ]
}

function defaultConfig(): ConfigData {
  return {
    settings: {
      ...defaultSettings,
      defaultModelId: "default-model",
      updatedAt: now(),
    },
    providers: defaultProviders(),
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizeToolTimeouts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...defaultToolTimeouts }
  }
  const merged: Record<string, number> = { ...defaultToolTimeouts }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      merged[key] = value
    }
  }
  return merged
}

function normalizeConversationToolExpand(
  raw: unknown
): SettingsPublic["conversationToolExpand"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...defaultConversationToolExpand }
  }
  const value = raw as Record<string, unknown>
  const bool = (key: keyof SettingsPublic["conversationToolExpand"]) =>
    typeof value[key] === "boolean"
      ? value[key]
      : defaultConversationToolExpand[key]
  return {
    fileRead: bool("fileRead"),
    fileEdit: bool("fileEdit"),
    bash: bool("bash"),
    target: bool("target"),
    flag: bool("flag"),
    agent: bool("agent"),
    errors: bool("errors"),
  }
}

function normalizeSettings(raw: unknown): SettingsPublic {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  // One-time migration: legacy config.json stored cpuLimit (millicores).
  // New schema stores cpus (cores) directly.
  const legacyCpuLimit = source.cpuLimit
  const migrated: Record<string, unknown> = { ...source }
  if (
    typeof legacyCpuLimit === "number" &&
    Number.isFinite(legacyCpuLimit) &&
    source.cpus === undefined
  ) {
    migrated.cpus = legacyCpuLimit / 1000
    delete migrated.cpuLimit
  }
  const base = { ...defaultSettings, ...migrated }
  const cleaned = Value.Clean(SettingsSchema, base) as Static<
    typeof SettingsSchema
  >
  return {
    defaultModelId:
      typeof cleaned.defaultModelId === "string"
        ? cleaned.defaultModelId
        : null,
    defaultThinkingLevel: Value.Check(
      ThinkingLevelSchema,
      cleaned.defaultThinkingLevel
    )
      ? cleaned.defaultThinkingLevel
      : "off",
    environment: Value.Check(EnvironmentSchema, cleaned.environment)
      ? cleaned.environment
      : "local",
    containerImage:
      typeof cleaned.containerImage === "string"
        ? cleaned.containerImage
        : defaultSettings.containerImage,
    cpus: finite(cleaned.cpus, defaultSettings.cpus),
    memoryMb: finite(cleaned.memoryMb, defaultSettings.memoryMb),
    pidsLimit: finite(cleaned.pidsLimit, defaultSettings.pidsLimit),
    maxConcurrency: finite(
      cleaned.maxConcurrency,
      defaultSettings.maxConcurrency
    ),
    maxAttachmentMb: finite(
      cleaned.maxAttachmentMb,
      defaultSettings.maxAttachmentMb
    ),
    mainSystemPromptTemplate:
      typeof cleaned.mainSystemPromptTemplate === "string"
        ? cleaned.mainSystemPromptTemplate
        : "",
    childSystemPromptTemplate:
      typeof cleaned.childSystemPromptTemplate === "string"
        ? cleaned.childSystemPromptTemplate
        : "",
    initialPromptTemplate:
      typeof cleaned.initialPromptTemplate === "string"
        ? cleaned.initialPromptTemplate
        : "",
    maxRetryAttempts: finite(
      cleaned.maxRetryAttempts,
      defaultSettings.maxRetryAttempts
    ),
    retryBaseDelayMs: finite(
      cleaned.retryBaseDelayMs,
      defaultSettings.retryBaseDelayMs
    ),
    retryMaxDelayMs: finite(
      cleaned.retryMaxDelayMs,
      defaultSettings.retryMaxDelayMs
    ),
    maxToolOutputBytes: finite(
      cleaned.maxToolOutputBytes,
      defaultSettings.maxToolOutputBytes
    ),
    maxInlineShellOutputBytes: finite(
      cleaned.maxInlineShellOutputBytes,
      defaultSettings.maxInlineShellOutputBytes
    ),
    maxCapturedShellOutputBytes: finite(
      cleaned.maxCapturedShellOutputBytes,
      defaultSettings.maxCapturedShellOutputBytes
    ),
    containerWorkspace:
      typeof cleaned.containerWorkspace === "string"
        ? cleaned.containerWorkspace
        : defaultSettings.containerWorkspace,
    dockerTimeoutMs: finite(
      cleaned.dockerTimeoutMs,
      defaultSettings.dockerTimeoutMs
    ),
    tmpfsSize:
      typeof cleaned.tmpfsSize === "string"
        ? cleaned.tmpfsSize
        : defaultSettings.tmpfsSize,
    platformRequestTimeoutMs: finite(
      cleaned.platformRequestTimeoutMs,
      defaultSettings.platformRequestTimeoutMs
    ),
    providerDiscoverTimeoutMs: finite(
      cleaned.providerDiscoverTimeoutMs,
      defaultSettings.providerDiscoverTimeoutMs
    ),
    defaultToolTimeoutMs: finite(
      cleaned.defaultToolTimeoutMs,
      defaultSettings.defaultToolTimeoutMs
    ),
    toolTimeouts: normalizeToolTimeouts(cleaned.toolTimeouts),
    renderUserMessagesAsMarkdown: cleaned.renderUserMessagesAsMarkdown === true,
    renderReasoningAsMarkdown: cleaned.renderReasoningAsMarkdown === true,
    conversationToolExpand: normalizeConversationToolExpand(
      cleaned.conversationToolExpand
    ),
    // Derived display-only fields; publicSettings() fills real values.
    defaultMainSystemPromptTemplate: "",
    defaultChildSystemPromptTemplate: "",
    defaultInitialPromptTemplate: "",
    promptTemplateVariables: [],
    updatedAt:
      typeof cleaned.updatedAt === "string" ? cleaned.updatedAt : now(),
  }
}

function normalizeModel(raw: unknown): ProviderModelData | undefined {
  if (!Value.Check(ProviderModelSchema, raw)) return undefined
  return {
    id: raw.id,
    modelId: typeof raw.modelId === "string" ? raw.modelId : "",
    label: typeof raw.label === "string" ? raw.label : "",
    enabled: raw.enabled !== false,
    metadata: typeof raw.metadata === "string" ? raw.metadata : "{}",
    piProviderId:
      typeof raw.piProviderId === "string" ? raw.piProviderId : null,
    piModelId: typeof raw.piModelId === "string" ? raw.piModelId : null,
  }
}

function normalizeProvider(raw: unknown): ProviderData | undefined {
  if (!Value.Check(ProviderSchema, raw)) return undefined
  const models = Array.isArray(raw.models)
    ? raw.models
        .map(normalizeModel)
        .filter((model): model is ProviderModelData => model !== undefined)
    : []
  return {
    id: raw.id,
    label: typeof raw.label === "string" ? raw.label : "",
    type: raw.type,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    enabled: raw.enabled !== false,
    models,
  }
}

function normalizeConfig(raw: unknown): ConfigData {
  const r =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const providers = Array.isArray(r.providers)
    ? r.providers
        .map(normalizeProvider)
        .filter((provider): provider is ProviderData => provider !== undefined)
    : []
  return {
    settings: normalizeSettings(r.settings),
    providers: providers.length > 0 ? providers : defaultProviders(),
  }
}

export function createConfigStore(dataDir: string) {
  const path = join(dataDir, "config.json")
  mkdirSync(dataDir, { recursive: true })

  function load(): ConfigData {
    if (existsSync(path)) {
      try {
        return normalizeConfig(JSON.parse(readFileSync(path, "utf8")))
      } catch {
        // corrupt file — fall through to defaults
      }
    }
    const defaults = defaultConfig()
    save(defaults)
    return defaults
  }

  function save(data: ConfigData) {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, path)
  }

  let data: ConfigData = load()

  return {
    get(): ConfigData {
      return data
    },
    getSettings(): SettingsPublic {
      return data.settings
    },
    getProviders(): ProviderData[] {
      return data.providers
    },
    updateSettings(patch: Partial<SettingsPublic>): SettingsPublic {
      data = {
        ...data,
        settings: { ...data.settings, ...patch, updatedAt: now() },
      }
      save(data)
      return data.settings
    },
    updateProviders(providers: ProviderData[]): void {
      data = { ...data, providers }
      save(data)
    },
    replaceAll(settings: SettingsPublic, providers: ProviderData[]): void {
      data = { settings: { ...settings, updatedAt: now() }, providers }
      save(data)
    },
    get path() {
      return path
    },
  }
}

export type ConfigStore = ReturnType<typeof createConfigStore>
