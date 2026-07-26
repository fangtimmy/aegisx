import type { Hono } from "hono"
import { Type } from "typebox"
import {
  type FlatSettings,
  get,
  isConfigDocumentV1,
  parseSettings,
  patchSettings,
} from "../../../shared"
import type {
  ConfigStore,
  ProviderData,
  ProviderModelData,
} from "../infrastructure/config-store"
import { validateJson } from "../infrastructure/validation"
import {
  builtinModelProfile,
  normalizeModelMetadata,
  parseModelMetadata,
} from "../providers/models"
import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  PROMPT_TEMPLATE_VARIABLES,
  previewInitialPrompt,
  previewSystemPrompt,
  samplePromptContext,
} from "./prompt-templates"

const promptPreviewInput = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("mainSystemPrompt"),
      Type.Literal("childSystemPrompt"),
      Type.Literal("initialPrompt"),
    ]),
    template: Type.String({ maxLength: 100_000 }),
  },
  { additionalProperties: false }
)

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider endpoint must use HTTP or HTTPS")
  }
  return url.toString().replace(/\/$/, "")
}

export function settingsResponse(configStore: ConfigStore) {
  return {
    settings: configStore.getSettings(),
    updatedAt: configStore.getUpdatedAt(),
    meta: {
      promptDefaults: {
        "prompts.mainSystem": DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
        "prompts.childSystem": DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
        "prompts.initial": DEFAULT_INITIAL_PROMPT_TEMPLATE,
      },
      promptVariables: [...PROMPT_TEMPLATE_VARIABLES],
    },
  }
}

export function registerSettingsRoutes(
  app: Hono,
  options: {
    configStore: ConfigStore
    setMaxConcurrency(value: number): void
    syncModels(): void
  }
) {
  const { configStore, setMaxConcurrency, syncModels } = options
  const childSampleContext = {
    ...samplePromptContext,
    agent: {
      role: "child" as const,
      isMain: false,
      name: "Recon agent",
      task: "Inspect the application endpoints.",
    },
  }
  const previewPrompt = (
    kind: "mainSystemPrompt" | "childSystemPrompt" | "initialPrompt",
    template: string
  ) => {
    if (kind === "mainSystemPrompt") {
      return previewSystemPrompt(template, samplePromptContext)
    }
    if (kind === "childSystemPrompt") {
      return previewSystemPrompt(template, childSampleContext)
    }
    return previewInitialPrompt(template, samplePromptContext)
  }

  const validatePromptKeys = (settings: FlatSettings) => {
    previewPrompt("mainSystemPrompt", get(settings, "prompts.mainSystem"))
    previewPrompt("childSystemPrompt", get(settings, "prompts.childSystem"))
    previewPrompt("initialPrompt", get(settings, "prompts.initial"))
  }

  const transferModel = (model: ProviderModelData) => ({
    id: model.id,
    modelId: model.modelId,
    label: model.label,
    enabled: model.enabled,
    metadata: parseModelMetadata(model.metadata),
    piBinding:
      model.piProviderId && model.piModelId
        ? { providerId: model.piProviderId, modelId: model.piModelId }
        : null,
  })

  const transferProviders = () =>
    configStore.getProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      enabled: provider.enabled,
      models: provider.models.map(transferModel),
    }))

  app.get("/api/settings", (c) => c.json(settingsResponse(configStore)))

  app.get("/api/settings/export", () => {
    const content = JSON.stringify(
      {
        version: 1,
        settings: configStore.getSettings(),
        providers: transferProviders(),
      },
      null,
      2
    )
    return new Response(content, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "attachment; filename=aegisx-settings.json",
      },
    })
  })

  app.patch("/api/settings", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_json",
            message: "Request body must be JSON",
          },
        },
        400
      )
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          error: {
            code: "invalid_settings",
            message: "Settings patch must be an object of flat keys",
          },
        },
        400
      )
    }
    const patch = body as Record<string, unknown>
    if ("agent.defaultModelId" in patch) {
      const modelId = patch["agent.defaultModelId"]
      if (modelId !== null && modelId !== undefined) {
        if (typeof modelId !== "string" || modelId.length === 0) {
          return c.json(
            {
              error: {
                code: "invalid_settings",
                message: "Default model id is invalid",
              },
            },
            400
          )
        }
        const exists = configStore
          .getProviders()
          .some((p) => p.models.some((m) => m.id === modelId))
        if (!exists) {
          return c.json(
            {
              error: {
                code: "not_found",
                message: "Default model not found",
              },
            },
            404
          )
        }
      }
    }
    const next = patchSettings(configStore.getSettings(), patch)
    try {
      validatePromptKeys(next)
    } catch (error) {
      return c.json(
        {
          error: {
            code: "invalid_prompt_template",
            message:
              error instanceof Error
                ? error.message
                : "Prompt template is invalid",
          },
        },
        400
      )
    }
    configStore.updateSettings(patch)
    setMaxConcurrency(get(next, "runtime.maxConcurrency"))
    return c.json(settingsResponse(configStore))
  })

  app.post(
    "/api/settings/prompts/preview",
    validateJson(promptPreviewInput),
    (c) => {
      try {
        const input = c.req.valid("json")
        return c.json({ segments: previewPrompt(input.kind, input.template) })
      } catch (error) {
        return c.json(
          {
            error: {
              code: "invalid_prompt_template",
              message:
                error instanceof Error
                  ? error.message
                  : "Prompt template is invalid",
            },
          },
          400
        )
      }
    }
  )

  app.post("/api/settings/import", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_json",
            message: "Request body must be JSON",
          },
        },
        400
      )
    }
    if (!isConfigDocumentV1(body)) {
      return c.json(
        {
          error: {
            code: "invalid_settings_import",
            message: "Unsupported settings file (expected version 1)",
          },
        },
        400
      )
    }
    try {
      const settings = parseSettings(body.settings)
      validatePromptKeys(settings)
      const providerIds = new Set<string>()
      const modelIds = new Set<string>()
      const providerModelIds = new Set<string>()
      const newProviders: ProviderData[] = []
      for (const raw of body.providers) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("Invalid provider entry")
        }
        const provider = raw as Record<string, unknown>
        if (typeof provider.id !== "string" || !provider.id) {
          throw new Error("Provider id is required")
        }
        if (providerIds.has(provider.id))
          throw new Error("Duplicate provider ID")
        providerIds.add(provider.id)
        if (typeof provider.label !== "string" || !provider.label.trim()) {
          throw new Error("Provider name is required")
        }
        if (
          provider.type !== "openai-compatible" &&
          provider.type !== "openai-responses" &&
          provider.type !== "anthropic-messages"
        ) {
          throw new Error("Invalid provider type")
        }
        if (typeof provider.baseUrl !== "string") {
          throw new Error("Provider endpoint is required")
        }
        const baseUrl = normalizeBaseUrl(provider.baseUrl)
        const modelsRaw = Array.isArray(provider.models) ? provider.models : []
        const models: ProviderModelData[] = []
        for (const rawModel of modelsRaw) {
          if (
            !rawModel ||
            typeof rawModel !== "object" ||
            Array.isArray(rawModel)
          ) {
            throw new Error("Invalid model entry")
          }
          const model = rawModel as Record<string, unknown>
          if (typeof model.id !== "string" || !model.id) {
            throw new Error("Model id is required")
          }
          if (modelIds.has(model.id)) throw new Error("Duplicate model ID")
          modelIds.add(model.id)
          if (typeof model.modelId !== "string" || !model.modelId.trim()) {
            throw new Error("Model ID and name are required")
          }
          if (typeof model.label !== "string" || !model.label.trim()) {
            throw new Error("Model ID and name are required")
          }
          const providerModelKey = `${provider.id}\u0000${model.modelId.trim()}`
          if (providerModelIds.has(providerModelKey)) {
            throw new Error("Duplicate model ID for provider")
          }
          providerModelIds.add(providerModelKey)
          const piBinding =
            model.piBinding &&
            typeof model.piBinding === "object" &&
            !Array.isArray(model.piBinding)
              ? (model.piBinding as Record<string, unknown>)
              : null
          const piProviderId =
            piBinding && typeof piBinding.providerId === "string"
              ? piBinding.providerId
              : null
          const piModelId =
            piBinding && typeof piBinding.modelId === "string"
              ? piBinding.modelId
              : null
          if (
            piProviderId &&
            piModelId &&
            !builtinModelProfile(piProviderId, piModelId)
          ) {
            throw new Error("Pi model binding is unavailable")
          }
          models.push({
            id: model.id,
            modelId: model.modelId.trim(),
            label: model.label.trim(),
            enabled: model.enabled !== false,
            metadata: JSON.stringify(
              normalizeModelMetadata(
                model.metadata ?? {
                  reasoning: model.reasoning ?? false,
                  thinkingLevelMap: model.thinkingLevelMap ?? {},
                }
              )
            ),
            piProviderId,
            piModelId,
          })
        }
        newProviders.push({
          id: provider.id,
          label: provider.label.trim(),
          type: provider.type,
          baseUrl,
          apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
          enabled: provider.enabled !== false,
          models,
        })
      }
      const defaultModelId = get(settings, "agent.defaultModelId")
      if (defaultModelId !== null && !modelIds.has(defaultModelId)) {
        throw new Error("Default model not found in imported configuration")
      }
      configStore.replaceAll(settings, newProviders)
      setMaxConcurrency(get(settings, "runtime.maxConcurrency"))
      syncModels()
      return c.json({
        version: 1,
        settings: configStore.getSettings(),
        providers: transferProviders(),
      })
    } catch (error) {
      return c.json(
        {
          error: {
            code: "invalid_settings_import",
            message:
              error instanceof Error ? error.message : "Settings import failed",
          },
        },
        400
      )
    }
  })
}
