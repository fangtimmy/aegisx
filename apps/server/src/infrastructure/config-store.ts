import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import {
  CONFIG_DOCUMENT_VERSION,
  defaultSettings,
  type FlatSettings,
  isRecord,
  type ProviderType,
  parseSettings,
  patchSettings,
} from "@aegisx/shared"
import { Type } from "typebox"
import { Value } from "typebox/value"

import { ProviderTypeSchema } from "../lib/schemas"
import { builtinModelProfile } from "../providers/builtin-models"

export type { FlatSettings }

export type ProviderModelData = {
  id: string
  modelId: string
  label: string
  enabled: boolean
  metadata: string
  metadataSource: string | null
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
  version: typeof CONFIG_DOCUMENT_VERSION
  settings: FlatSettings
  providers: ProviderData[]
  updatedAt: string
}

const now = () => new Date().toISOString()

const ProviderModelSchema = Type.Object(
  {
    id: Type.String(),
    modelId: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    metadata: Type.Optional(Type.String()),
    metadataSource: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
  // Seed Anthropic with the real claude-sonnet-4-5 metadata copied from pi's
  // builtin catalog (provenance recorded so the settings UI can re-sync).
  const profile = builtinModelProfile("anthropic", "claude-sonnet-4-5")
  return [
    {
      id: "default-provider",
      label: "Anthropic",
      type: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      enabled: true,
      models: [
        {
          id: "default-model",
          modelId: "claude-sonnet-4-5",
          label: profile?.name ?? "Claude Sonnet 4.5",
          enabled: true,
          metadata: JSON.stringify(profile?.metadata ?? {}),
          metadataSource: profile ? "pi:anthropic/claude-sonnet-4-5" : null,
        },
      ],
    },
  ]
}

function defaultConfig(): ConfigData {
  const settings = defaultSettings()
  return {
    version: CONFIG_DOCUMENT_VERSION,
    settings,
    providers: defaultProviders(),
    updatedAt: now(),
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
    metadataSource:
      typeof raw.metadataSource === "string" ? raw.metadataSource : null,
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

function normalizeProviders(raw: unknown): ProviderData[] {
  // An explicit empty array is a deliberate state (the user deleted all
  // providers) — only a non-array (corrupt field) falls back to the seeds.
  if (!Array.isArray(raw)) return defaultProviders()
  return raw
    .map(normalizeProvider)
    .filter((provider): provider is ProviderData => provider !== undefined)
}

function isCurrentDocument(raw: unknown): raw is {
  version: 1
  settings: unknown
  providers: unknown
  updatedAt?: unknown
} {
  if (!isRecord(raw)) return false
  return raw.version === CONFIG_DOCUMENT_VERSION
}

export function createConfigStore(dataDir: string) {
  const path = join(dataDir, "config.json")
  mkdirSync(dataDir, { recursive: true })

  function save(data: ConfigData) {
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: data.version,
          settings: data.settings,
          providers: data.providers,
          updatedAt: data.updatedAt,
        },
        null,
        2
      )
    )
    renameSync(tmp, path)
  }

  function load(): ConfigData {
    if (!existsSync(path)) {
      const defaults = defaultConfig()
      save(defaults)
      return defaults
    }
    try {
      const doc: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (!isRecord(doc)) {
        throw new Error("invalid config root")
      }

      // Current flat document
      if (isCurrentDocument(doc)) {
        const providers = normalizeProviders(doc.providers)
        return {
          version: CONFIG_DOCUMENT_VERSION,
          settings: parseSettings(doc.settings),
          providers,
          updatedAt:
            typeof doc.updatedAt === "string" && doc.updatedAt
              ? doc.updatedAt
              : now(),
        }
      }

      throw new Error("unsupported config shape")
    } catch (error) {
      console.warn("Config load failed, resetting to defaults", {
        error: error instanceof Error ? error.message : String(error),
      })
      try {
        if (existsSync(path)) {
          renameSync(path, `${path}.bak.${Date.now()}`)
        }
      } catch {
        // ignore backup failure
      }
      const defaults = defaultConfig()
      save(defaults)
      return defaults
    }
  }

  let data: ConfigData = load()
  // In-memory generation counter for config writes. Bumped on every mutation
  // so run-lifecycle code can detect drift between a workspace's cached
  // ModelRuntime snapshot and the current provider/settings config (e.g.
  // apiKey edits) and lazily refresh before resolving a model.
  let configVersion = 0

  return {
    get(): ConfigData {
      return data
    },
    getSettings(): FlatSettings {
      return data.settings
    },
    getUpdatedAt(): string {
      return data.updatedAt
    },
    /** Monotonic counter bumped on every settings/providers mutation
     * (in-memory; resets on restart). Consumers compare against a cached
     * snapshot to decide whether a workspace's ModelRuntime needs
     * refreshing. */
    get configVersion(): number {
      return configVersion
    },
    getProviders(): ProviderData[] {
      return data.providers
    },
    updateSettings(patch: unknown): FlatSettings {
      data = {
        ...data,
        settings: patchSettings(data.settings, patch),
        updatedAt: now(),
      }
      configVersion++
      save(data)
      return data.settings
    },
    updateProviders(providers: ProviderData[]): void {
      data = { ...data, providers, updatedAt: now() }
      configVersion++
      save(data)
    },
    replaceAll(settings: FlatSettings, providers: ProviderData[]): void {
      data = {
        version: CONFIG_DOCUMENT_VERSION,
        settings: parseSettings(settings),
        providers,
        updatedAt: now(),
      }
      configVersion++
      save(data)
    },
    exportDocument() {
      return {
        version: CONFIG_DOCUMENT_VERSION,
        settings: data.settings,
        providers: data.providers,
      }
    },
    get path() {
      return path
    },
  }
}

export type ConfigStore = ReturnType<typeof createConfigStore>
