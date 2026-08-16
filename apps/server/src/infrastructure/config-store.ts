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
  extractLegacyPromptTemplates,
  type FlatSettings,
  migrateLegacySettings,
  type ModelAlias,
  type ProviderType,
  parseAliases,
  parseSettings,
  patchSettings,
} from "@aegisx/shared"
import { Type } from "typebox"
import { Value } from "typebox/value"

import { ProviderTypeSchema } from "../lib/schemas"

export type { FlatSettings }

/** Stored model alias shape (see @aegisx/shared/alias). */
export type AliasData = ModelAlias

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
  version: typeof CONFIG_DOCUMENT_VERSION
  settings: FlatSettings
  providers: ProviderData[]
  aliases: AliasData[]
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
  const settings = defaultSettings()
  return {
    version: CONFIG_DOCUMENT_VERSION,
    settings,
    providers: defaultProviders(),
    aliases: [],
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

function normalizeProviders(raw: unknown): ProviderData[] {
  if (!Array.isArray(raw)) return defaultProviders()
  const providers = raw
    .map(normalizeProvider)
    .filter((provider): provider is ProviderData => provider !== undefined)
  return providers.length > 0 ? providers : defaultProviders()
}

function isCurrentDocument(raw: unknown): raw is {
  version: 1
  settings: unknown
  providers: unknown
  aliases?: unknown
  updatedAt?: unknown
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  const doc = raw as Record<string, unknown>
  return doc.version === CONFIG_DOCUMENT_VERSION
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
          aliases: data.aliases,
          updatedAt: data.updatedAt,
        },
        null,
        2
      )
    )
    renameSync(tmp, path)
  }

  // Pre-v8 prompt templates (FlatSettings `prompts.*` / unversioned `*PromptTemplate`)
  // captured at load, before parseSettings drops them; see getLegacyPromptTemplates.
  let legacyPrompts: Record<string, string> | undefined = undefined

  function load(): ConfigData {
    if (!existsSync(path)) {
      const defaults = defaultConfig()
      save(defaults)
      return defaults
    }
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("invalid config root")
      }
      const doc = raw as Record<string, unknown>
      legacyPrompts = extractLegacyPromptTemplates(doc.settings)

      // Current flat document
      if (isCurrentDocument(raw)) {
        return {
          version: CONFIG_DOCUMENT_VERSION,
          settings: parseSettings(doc.settings),
          providers: normalizeProviders(doc.providers),
          aliases: parseAliases(doc.aliases),
          updatedAt:
            typeof doc.updatedAt === "string" && doc.updatedAt
              ? doc.updatedAt
              : now(),
        }
      }

      // Legacy unversioned { settings, providers } — migrate in place
      if (doc.settings !== undefined && Array.isArray(doc.providers)) {
        const migrated: ConfigData = {
          version: CONFIG_DOCUMENT_VERSION,
          settings: migrateLegacySettings(doc.settings),
          providers: normalizeProviders(doc.providers),
          aliases: parseAliases(doc.aliases),
          updatedAt: now(),
        }
        save(migrated)
        return migrated
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

  return {
    get(): ConfigData {
      return data
    },
    getSettings(): FlatSettings {
      return data.settings
    },
    /** Pre-v8 prompt-template edits captured from the raw config document
     * before parseSettings drops them (v8 keeps templates in the
     * prompt_templates table). Keyed by template key. */
    getLegacyPromptTemplates(): Record<string, string> | undefined {
      return legacyPrompts
    },
    getUpdatedAt(): string {
      return data.updatedAt
    },
    getProviders(): ProviderData[] {
      return data.providers
    },
    getAliases(): AliasData[] {
      return data.aliases
    },
    updateSettings(patch: Partial<FlatSettings> | unknown): FlatSettings {
      data = {
        ...data,
        settings: patchSettings(data.settings, patch),
        updatedAt: now(),
      }
      save(data)
      return data.settings
    },
    updateProviders(providers: ProviderData[]): void {
      data = { ...data, providers, updatedAt: now() }
      save(data)
    },
    updateAliases(aliases: AliasData[]): void {
      data = { ...data, aliases, updatedAt: now() }
      save(data)
    },
    replaceAll(
      settings: FlatSettings,
      providers: ProviderData[],
      aliases: AliasData[] = data.aliases
    ): void {
      data = {
        version: CONFIG_DOCUMENT_VERSION,
        settings: parseSettings(settings),
        providers,
        aliases,
        updatedAt: now(),
      }
      save(data)
    },
    exportDocument() {
      return {
        version: CONFIG_DOCUMENT_VERSION,
        settings: data.settings,
        providers: data.providers,
        aliases: data.aliases,
      }
    },
    get path() {
      return path
    },
  }
}

export type ConfigStore = ReturnType<typeof createConfigStore>
