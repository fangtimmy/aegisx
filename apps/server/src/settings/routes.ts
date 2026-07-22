import type { Hono } from "hono"
import { Type } from "typebox"
import { normalizeThinkingLevel } from "../../../shared/api"
import type {
  ConfigStore,
  ProviderData,
  ProviderModelData,
  SettingsData,
} from "../infrastructure/config-store"
import { notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  builtinModelProfile,
  normalizeModelMetadata,
  parseModelMetadata,
  providerApi,
} from "../providers/models"
import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  PROMPT_TEMPLATE_VARIABLES,
  previewInitialPrompt,
  previewSystemPrompt,
  resolvePromptTemplates,
  samplePromptContext,
} from "./prompt-templates"

const thinkingLevelUnion = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
])

const runtimeSettingsInput = Type.Object(
  {
    defaultModelId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    defaultThinkingLevel: thinkingLevelUnion,
    environment: Type.Union([Type.Literal("local"), Type.Literal("container")]),
    containerImage: Type.String({
      minLength: 1,
      maxLength: 300,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._/:@-]*$",
    }),
    cpus: Type.Number({ minimum: 0.1, maximum: 16 }),
    memoryMb: Type.Integer({ minimum: 128, maximum: 32_768 }),
    pidsLimit: Type.Integer({ minimum: 16, maximum: 4_096 }),
    maxConcurrency: Type.Integer({ minimum: 1, maximum: 32 }),
    maxAttachmentMb: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_240 })
    ),
    maxRetryAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    retryBaseDelayMs: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 120_000 })
    ),
    retryMaxDelayMs: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 600_000 })
    ),
    maxToolOutputBytes: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 1_000_000 })
    ),
    maxInlineShellOutputBytes: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 500_000 })
    ),
    maxCapturedShellOutputBytes: Type.Optional(
      Type.Integer({ minimum: 10_000, maximum: 50_000_000 })
    ),
    containerWorkspace: Type.Optional(
      Type.String({ minLength: 1, maxLength: 500 })
    ),
    dockerTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 300_000 })
    ),
    tmpfsSize: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
    platformRequestTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 300_000 })
    ),
    providerDiscoverTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 120_000 })
    ),
    defaultToolTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 600_000 })
    ),
    toolTimeouts: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Integer({ minimum: 1_000, maximum: 600_000 })
      )
    ),
  },
  { additionalProperties: false }
)

const providerType = Type.Union([
  Type.Literal("openai-compatible"),
  Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"),
])

const promptTemplatesInput = Type.Object(
  {
    mainSystemPromptTemplate: Type.String({ maxLength: 100_000 }),
    childSystemPromptTemplate: Type.String({ maxLength: 100_000 }),
    initialPromptTemplate: Type.String({ maxLength: 100_000 }),
  },
  { additionalProperties: false }
)

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

const settingsTransferInput = Type.Object(
  {
    version: Type.Literal(2),
    settings: Type.Object(
      {
        defaultModelId: Type.Union([
          Type.String({ minLength: 1 }),
          Type.Null(),
        ]),
        defaultThinkingLevel: thinkingLevelUnion,
        environment: Type.Union([
          Type.Literal("local"),
          Type.Literal("container"),
        ]),
        containerImage: Type.String({
          minLength: 1,
          maxLength: 300,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._/:@-]*$",
        }),
        cpus: Type.Number({ minimum: 0.1, maximum: 16 }),
        memoryMb: Type.Integer({ minimum: 128, maximum: 32_768 }),
        pidsLimit: Type.Integer({ minimum: 16, maximum: 4_096 }),
        maxConcurrency: Type.Integer({ minimum: 1, maximum: 32 }),
        maxAttachmentMb: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 10_240 })
        ),
        mainSystemPromptTemplate: Type.String({ maxLength: 100_000 }),
        childSystemPromptTemplate: Type.String({ maxLength: 100_000 }),
        initialPromptTemplate: Type.String({ maxLength: 100_000 }),
      },
      { additionalProperties: false }
    ),
    providers: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 200 }),
          label: Type.String({ minLength: 1, maxLength: 100 }),
          type: providerType,
          baseUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
          apiKey: Type.String({ maxLength: 10_000 }),
          enabled: Type.Boolean(),
          models: Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: 200 }),
                modelId: Type.String({ minLength: 1, maxLength: 200 }),
                label: Type.String({ minLength: 1, maxLength: 200 }),
                enabled: Type.Boolean(),
                metadata: Type.Optional(Type.Unknown()),
                piBinding: Type.Optional(
                  Type.Union([
                    Type.Object({
                      providerId: Type.String({ minLength: 1, maxLength: 200 }),
                      modelId: Type.String({ minLength: 1, maxLength: 200 }),
                    }),
                    Type.Null(),
                  ])
                ),
                reasoning: Type.Optional(Type.Boolean()),
                thinkingLevelMap: Type.Optional(Type.Unknown()),
              },
              { additionalProperties: false }
            )
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
)

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
  const validatePrompts = (input: {
    mainSystemPromptTemplate: string
    childSystemPromptTemplate: string
    initialPromptTemplate: string
  }) => {
    previewPrompt("mainSystemPrompt", input.mainSystemPromptTemplate)
    previewPrompt("childSystemPrompt", input.childSystemPromptTemplate)
    previewPrompt("initialPrompt", input.initialPromptTemplate)
  }

  const publicSettings = () => {
    const value = configStore.getSettings()
    const promptTemplates = resolvePromptTemplates(value)
    return {
      defaultModelId: value.defaultModelId,
      defaultThinkingLevel: normalizeThinkingLevel(value.defaultThinkingLevel),
      environment: value.environment,
      containerImage: value.containerImage,
      cpus: value.cpuLimit / 1000,
      memoryMb: value.memoryMb,
      pidsLimit: value.pidsLimit,
      maxConcurrency: value.maxConcurrency,
      maxAttachmentMb: value.maxAttachmentMb,
      maxRetryAttempts: value.maxRetryAttempts,
      retryBaseDelayMs: value.retryBaseDelayMs,
      retryMaxDelayMs: value.retryMaxDelayMs,
      maxToolOutputBytes: value.maxToolOutputBytes,
      maxInlineShellOutputBytes: value.maxInlineShellOutputBytes,
      maxCapturedShellOutputBytes: value.maxCapturedShellOutputBytes,
      containerWorkspace: value.containerWorkspace,
      dockerTimeoutMs: value.dockerTimeoutMs,
      tmpfsSize: value.tmpfsSize,
      platformRequestTimeoutMs: value.platformRequestTimeoutMs,
      providerDiscoverTimeoutMs: value.providerDiscoverTimeoutMs,
      defaultToolTimeoutMs: value.defaultToolTimeoutMs,
      toolTimeouts: { ...value.toolTimeouts },
      ...promptTemplates,
      defaultMainSystemPromptTemplate: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
      defaultChildSystemPromptTemplate: DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
      defaultInitialPromptTemplate: DEFAULT_INITIAL_PROMPT_TEMPLATE,
      promptTemplateVariables: PROMPT_TEMPLATE_VARIABLES,
      updatedAt: value.updatedAt,
    }
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
  const transferData = () => {
    const value = configStore.getSettings()
    return {
      version: 2 as const,
      settings: {
        defaultModelId: value.defaultModelId,
        defaultThinkingLevel: normalizeThinkingLevel(
          value.defaultThinkingLevel
        ),
        environment: value.environment,
        containerImage: value.containerImage,
        cpus: value.cpuLimit / 1000,
        memoryMb: value.memoryMb,
        pidsLimit: value.pidsLimit,
        maxConcurrency: value.maxConcurrency,
        maxAttachmentMb: value.maxAttachmentMb,
        ...resolvePromptTemplates(value),
      },
      providers: configStore.getProviders().map((provider) => ({
        id: provider.id,
        label: provider.label,
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        enabled: provider.enabled,
        models: provider.models.map(transferModel),
      })),
    }
  }

  app.get("/api/settings", (c) => c.json(publicSettings()))

  app.get("/api/settings/export", () => {
    const content = JSON.stringify(transferData(), null, 2)
    return new Response(content, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "attachment; filename=aegisx-settings.json",
      },
    })
  })

  app.patch("/api/settings", validateJson(runtimeSettingsInput), (c) => {
    const input = c.req.valid("json")
    if (input.defaultModelId) {
      const exists = configStore
        .getProviders()
        .some((p) => p.models.some((m) => m.id === input.defaultModelId))
      if (!exists) return notFound(c, "Default model not found")
    }
    const current = configStore.getSettings()
    const patch: Partial<SettingsData> = {
      defaultModelId: input.defaultModelId,
      defaultThinkingLevel: input.defaultThinkingLevel,
      environment: input.environment,
      containerImage: input.containerImage.trim(),
      cpuLimit: Math.round(input.cpus * 1000),
      memoryMb: input.memoryMb,
      pidsLimit: input.pidsLimit,
      maxConcurrency: input.maxConcurrency,
      maxAttachmentMb: input.maxAttachmentMb ?? current.maxAttachmentMb,
    }
    if (input.maxRetryAttempts !== undefined)
      patch.maxRetryAttempts = input.maxRetryAttempts
    if (input.retryBaseDelayMs !== undefined)
      patch.retryBaseDelayMs = input.retryBaseDelayMs
    if (input.retryMaxDelayMs !== undefined)
      patch.retryMaxDelayMs = input.retryMaxDelayMs
    if (input.maxToolOutputBytes !== undefined)
      patch.maxToolOutputBytes = input.maxToolOutputBytes
    if (input.maxInlineShellOutputBytes !== undefined)
      patch.maxInlineShellOutputBytes = input.maxInlineShellOutputBytes
    if (input.maxCapturedShellOutputBytes !== undefined)
      patch.maxCapturedShellOutputBytes = input.maxCapturedShellOutputBytes
    if (input.containerWorkspace !== undefined)
      patch.containerWorkspace = input.containerWorkspace
    if (input.dockerTimeoutMs !== undefined)
      patch.dockerTimeoutMs = input.dockerTimeoutMs
    if (input.tmpfsSize !== undefined) patch.tmpfsSize = input.tmpfsSize
    if (input.platformRequestTimeoutMs !== undefined)
      patch.platformRequestTimeoutMs = input.platformRequestTimeoutMs
    if (input.providerDiscoverTimeoutMs !== undefined)
      patch.providerDiscoverTimeoutMs = input.providerDiscoverTimeoutMs
    if (input.defaultToolTimeoutMs !== undefined)
      patch.defaultToolTimeoutMs = input.defaultToolTimeoutMs
    if (input.toolTimeouts !== undefined)
      patch.toolTimeouts = input.toolTimeouts
    configStore.updateSettings(patch)
    setMaxConcurrency(input.maxConcurrency)
    return c.json(publicSettings())
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

  app.patch(
    "/api/settings/prompts",
    validateJson(promptTemplatesInput),
    (c) => {
      const input = c.req.valid("json")
      try {
        validatePrompts(input)
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
      configStore.updateSettings(input)
      return c.json(publicSettings())
    }
  )

  app.post("/api/settings/import", validateJson(settingsTransferInput), (c) => {
    const input = c.req.valid("json")
    const providerIds = new Set<string>()
    const modelIds = new Set<string>()
    const providerModelIds = new Set<string>()
    const newProviders: ProviderData[] = []
    try {
      for (const provider of input.providers) {
        if (providerIds.has(provider.id))
          throw new Error("Duplicate provider ID")
        providerIds.add(provider.id)
        const baseUrl = normalizeBaseUrl(provider.baseUrl)
        const label = provider.label.trim()
        if (!label) throw new Error("Provider name is required")
        const models: ProviderModelData[] = []
        for (const model of provider.models) {
          if (modelIds.has(model.id)) throw new Error("Duplicate model ID")
          modelIds.add(model.id)
          const modelId = model.modelId.trim()
          const modelLabel = model.label.trim()
          if (!modelId || !modelLabel) {
            throw new Error("Model ID and name are required")
          }
          const providerModelKey = `${provider.id}\u0000${modelId}`
          if (providerModelIds.has(providerModelKey)) {
            throw new Error("Duplicate model ID for provider")
          }
          providerModelIds.add(providerModelKey)
          if (
            model.piBinding &&
            !builtinModelProfile(
              model.piBinding.providerId,
              model.piBinding.modelId,
              providerApi(provider.type)
            )
          ) {
            throw new Error("Pi model binding is unavailable for this provider")
          }
          models.push({
            id: model.id,
            modelId,
            label: modelLabel,
            enabled: model.enabled,
            metadata: JSON.stringify(
              normalizeModelMetadata(
                model.metadata ?? {
                  reasoning: model.reasoning ?? false,
                  thinkingLevelMap: model.thinkingLevelMap ?? {},
                }
              )
            ),
            piProviderId: model.piBinding?.providerId ?? null,
            piModelId: model.piBinding?.modelId ?? null,
          })
        }
        newProviders.push({
          id: provider.id,
          label,
          type: provider.type,
          baseUrl,
          apiKey: provider.apiKey,
          enabled: provider.enabled,
          models,
        })
      }
      if (
        input.settings.defaultModelId !== null &&
        !modelIds.has(input.settings.defaultModelId)
      ) {
        throw new Error("Default model not found in imported configuration")
      }
      validatePrompts(input.settings)
      const current = configStore.getSettings()
      configStore.replaceAll(
        {
          ...current,
          defaultModelId: input.settings.defaultModelId,
          defaultThinkingLevel: input.settings.defaultThinkingLevel,
          environment: input.settings.environment,
          containerImage: input.settings.containerImage.trim(),
          cpuLimit: Math.round(input.settings.cpus * 1000),
          memoryMb: input.settings.memoryMb,
          pidsLimit: input.settings.pidsLimit,
          maxConcurrency: input.settings.maxConcurrency,
          maxAttachmentMb:
            input.settings.maxAttachmentMb ?? current.maxAttachmentMb,
          mainSystemPromptTemplate: input.settings.mainSystemPromptTemplate,
          childSystemPromptTemplate: input.settings.childSystemPromptTemplate,
          initialPromptTemplate: input.settings.initialPromptTemplate,
        },
        newProviders
      )
      setMaxConcurrency(input.settings.maxConcurrency)
      syncModels()
      return c.json(transferData())
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

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider endpoint must use HTTP or HTTPS")
  }
  return url.toString().replace(/\/$/, "")
}
