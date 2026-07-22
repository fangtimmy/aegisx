import { Database } from "bun:sqlite"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
export type Environment = "local" | "container"
export type ProviderType =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-messages"

export type SettingsData = {
  defaultModelId: string | null
  defaultThinkingLevel: ThinkingLevel
  environment: Environment
  containerImage: string
  cpuLimit: number
  memoryMb: number
  pidsLimit: number
  maxConcurrency: number
  maxAttachmentMb: number
  mainSystemPromptTemplate: string
  childSystemPromptTemplate: string
  initialPromptTemplate: string
  maxRetryAttempts: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  maxToolOutputBytes: number
  maxInlineShellOutputBytes: number
  maxCapturedShellOutputBytes: number
  containerWorkspace: string
  dockerTimeoutMs: number
  tmpfsSize: string
  platformRequestTimeoutMs: number
  providerDiscoverTimeoutMs: number
  updatedAt: string
}

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
  settings: SettingsData
  providers: ProviderData[]
}

const now = () => new Date().toISOString()

export const defaultSettings: SettingsData = {
  defaultModelId: null,
  defaultThinkingLevel: "off",
  environment: "local",
  containerImage: "alpine:3.22",
  cpuLimit: 2000,
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
  updatedAt: "",
}

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

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return (
    v === "off" ||
    v === "minimal" ||
    v === "low" ||
    v === "medium" ||
    v === "high" ||
    v === "xhigh" ||
    v === "max"
  )
}

function isEnvironment(v: unknown): v is Environment {
  return v === "local" || v === "container"
}

function isProviderType(v: unknown): v is ProviderType {
  return (
    v === "openai-compatible" ||
    v === "openai-responses" ||
    v === "anthropic-messages"
  )
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback
}

function normalizeSettings(raw: unknown): SettingsData {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    defaultModelId:
      typeof r.defaultModelId === "string" ? r.defaultModelId : null,
    defaultThinkingLevel: isThinkingLevel(r.defaultThinkingLevel)
      ? r.defaultThinkingLevel
      : "off",
    environment: isEnvironment(r.environment) ? r.environment : "local",
    containerImage: str(r.containerImage, defaultSettings.containerImage),
    cpuLimit: num(r.cpuLimit, defaultSettings.cpuLimit),
    memoryMb: num(r.memoryMb, defaultSettings.memoryMb),
    pidsLimit: num(r.pidsLimit, defaultSettings.pidsLimit),
    maxConcurrency: num(r.maxConcurrency, defaultSettings.maxConcurrency),
    maxAttachmentMb: num(r.maxAttachmentMb, defaultSettings.maxAttachmentMb),
    mainSystemPromptTemplate: str(
      r.mainSystemPromptTemplate,
      defaultSettings.mainSystemPromptTemplate
    ),
    childSystemPromptTemplate: str(
      r.childSystemPromptTemplate,
      defaultSettings.childSystemPromptTemplate
    ),
    initialPromptTemplate: str(
      r.initialPromptTemplate,
      defaultSettings.initialPromptTemplate
    ),
    maxRetryAttempts: num(r.maxRetryAttempts, defaultSettings.maxRetryAttempts),
    retryBaseDelayMs: num(r.retryBaseDelayMs, defaultSettings.retryBaseDelayMs),
    retryMaxDelayMs: num(r.retryMaxDelayMs, defaultSettings.retryMaxDelayMs),
    maxToolOutputBytes: num(
      r.maxToolOutputBytes,
      defaultSettings.maxToolOutputBytes
    ),
    maxInlineShellOutputBytes: num(
      r.maxInlineShellOutputBytes,
      defaultSettings.maxInlineShellOutputBytes
    ),
    maxCapturedShellOutputBytes: num(
      r.maxCapturedShellOutputBytes,
      defaultSettings.maxCapturedShellOutputBytes
    ),
    containerWorkspace: str(
      r.containerWorkspace,
      defaultSettings.containerWorkspace
    ),
    dockerTimeoutMs: num(r.dockerTimeoutMs, defaultSettings.dockerTimeoutMs),
    tmpfsSize: str(r.tmpfsSize, defaultSettings.tmpfsSize),
    platformRequestTimeoutMs: num(
      r.platformRequestTimeoutMs,
      defaultSettings.platformRequestTimeoutMs
    ),
    providerDiscoverTimeoutMs: num(
      r.providerDiscoverTimeoutMs,
      defaultSettings.providerDiscoverTimeoutMs
    ),
    updatedAt: str(r.updatedAt, now()),
  }
}

function normalizeModel(raw: unknown): ProviderModelData | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string") return undefined
  return {
    id: r.id,
    modelId: str(r.modelId, ""),
    label: str(r.label, ""),
    enabled: r.enabled !== false,
    metadata: str(r.metadata, "{}"),
    piProviderId: typeof r.piProviderId === "string" ? r.piProviderId : null,
    piModelId: typeof r.piModelId === "string" ? r.piModelId : null,
  }
}

function normalizeProvider(raw: unknown): ProviderData | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string" || !isProviderType(r.type)) return undefined
  const models = Array.isArray(r.models)
    ? r.models
        .map(normalizeModel)
        .filter((m): m is ProviderModelData => m !== undefined)
    : []
  return {
    id: r.id,
    label: str(r.label, ""),
    type: r.type,
    baseUrl: str(r.baseUrl, ""),
    apiKey: str(r.apiKey, ""),
    enabled: r.enabled !== false,
    models,
  }
}

function normalizeConfig(raw: unknown): ConfigData {
  const r = (raw ?? {}) as Record<string, unknown>
  const providers = Array.isArray(r.providers)
    ? r.providers
        .map(normalizeProvider)
        .filter((p): p is ProviderData => p !== undefined)
    : []
  return {
    settings: normalizeSettings(r.settings),
    providers: providers.length > 0 ? providers : defaultProviders(),
  }
}

function tryMigrateFromDb(dataDir: string): ConfigData | undefined {
  const dbPath = join(dataDir, "aegisx.sqlite")
  if (!existsSync(dbPath)) return undefined
  try {
    const sqlite = new Database(dbPath, { readonly: true })
    try {
      const settingsRow = sqlite
        .query("SELECT * FROM settings WHERE id = 1 LIMIT 1")
        .get() as Record<string, unknown> | null
      const providers = sqlite
        .query("SELECT * FROM provider_connections ORDER BY created_at")
        .all() as Array<Record<string, unknown>>
      const models = sqlite
        .query("SELECT * FROM provider_models ORDER BY created_at")
        .all() as Array<Record<string, unknown>>
      if (!settingsRow && providers.length === 0) return undefined

      const settings = settingsRow
        ? normalizeSettings({
            ...settingsRow,
            ...defaultSettings,
            defaultModelId: settingsRow.default_model_id ?? null,
            defaultThinkingLevel: settingsRow.default_thinking_level ?? "off",
            environment: settingsRow.environment ?? "local",
            containerImage: settingsRow.container_image ?? "alpine:3.22",
            cpuLimit: settingsRow.cpu_limit ?? 2000,
            memoryMb: settingsRow.memory_mb ?? 2048,
            pidsLimit: settingsRow.pids_limit ?? 256,
            maxConcurrency: settingsRow.max_concurrency ?? 2,
            maxAttachmentMb: settingsRow.max_attachment_mb ?? 512,
            mainSystemPromptTemplate:
              settingsRow.system_prompt_template ??
              settingsRow.main_system_prompt_template ??
              "",
            childSystemPromptTemplate:
              settingsRow.child_system_prompt_template ?? "",
            initialPromptTemplate: settingsRow.initial_prompt_template ?? "",
            updatedAt: settingsRow.updated_at ?? now(),
          })
        : { ...defaultSettings, updatedAt: now() }

      const providerData: ProviderData[] = providers.map((p) => ({
        id: String(p.id),
        label: String(p.label),
        type: p.type as ProviderType,
        baseUrl: String(p.base_url),
        apiKey: String(p.api_key),
        enabled: p.enabled === 1 || p.enabled === true,
        models: models
          .filter((m) => m.provider_id === p.id)
          .map((m) => ({
            id: String(m.id),
            modelId: String(m.model_id),
            label: String(m.label),
            enabled: m.enabled === 1 || m.enabled === true,
            metadata: String(m.metadata ?? "{}"),
            piProviderId:
              typeof m.pi_provider_id === "string" ? m.pi_provider_id : null,
            piModelId: typeof m.pi_model_id === "string" ? m.pi_model_id : null,
          })),
      }))

      return { settings, providers: providerData }
    } finally {
      sqlite.close()
    }
  } catch {
    return undefined
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
        // corrupt file — fall through to migration/defaults
      }
    }
    const migrated = tryMigrateFromDb(dataDir)
    if (migrated) {
      console.log("[config] Migrated settings from database to config.json")
      save(migrated)
      return migrated
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
    getSettings(): SettingsData {
      return data.settings
    },
    getProviders(): ProviderData[] {
      return data.providers
    },
    updateSettings(patch: Partial<SettingsData>): SettingsData {
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
    replaceAll(settings: SettingsData, providers: ProviderData[]): void {
      data = { settings: { ...settings, updatedAt: now() }, providers }
      save(data)
    },
    get path() {
      return path
    },
  }
}

export type ConfigStore = ReturnType<typeof createConfigStore>
