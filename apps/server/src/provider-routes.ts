import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"
import type { createDatabase } from "./db"
import { providerConnections, providerModels, settings } from "./db/schema"
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
import { validateJson } from "./validation"

type Database = ReturnType<typeof createDatabase>["db"]

const runtimeSettingsInput = Type.Object(
  {
    defaultModelId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
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

const providerInput = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 100 }),
    type: providerType,
    baseUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
    apiKey: Type.String({ maxLength: 10_000 }),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false }
)

const providerUpdateInput = Type.Partial(providerInput, {
  additionalProperties: false,
})

const modelInput = Type.Object(
  {
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false }
)

const modelUpdateInput = Type.Partial(
  Type.Object(
    {
      label: Type.String({ minLength: 1, maxLength: 200 }),
      enabled: Type.Boolean(),
    },
    { additionalProperties: false }
  ),
  { additionalProperties: false }
)

export const providerName = (id: string) => `aegisx-${id}`

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider endpoint must use HTTP or HTTPS")
  }
  return url.toString().replace(/\/$/, "")
}

export function registerProviderRoutes(
  app: Hono,
  options: {
    db: Database
    getSettings(): typeof settings.$inferSelect
    listProviderModels(
      providerId: string
    ): Array<typeof providerModels.$inferSelect>
    syncModels(): void
    setMaxConcurrency(value: number): void
  }
) {
  const { db, getSettings, listProviderModels, syncModels } = options
  const getProvider = (providerId: string) =>
    db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, providerId))
      .get()
  const publicSettings = () => {
    const value = getSettings()
    const promptTemplates = resolvePromptTemplates(value)
    return {
      defaultModelId: value.defaultModelId,
      environment: value.environment as "local" | "container",
      containerImage: value.containerImage,
      cpus: value.cpuLimit / 1000,
      memoryMb: value.memoryMb,
      pidsLimit: value.pidsLimit,
      maxConcurrency: value.maxConcurrency,
      ...promptTemplates,
      defaultMainSystemPromptTemplate: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
      defaultChildSystemPromptTemplate: DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
      defaultInitialPromptTemplate: DEFAULT_INITIAL_PROMPT_TEMPLATE,
      promptTemplateVariables: PROMPT_TEMPLATE_VARIABLES,
      updatedAt: value.updatedAt,
    }
  }
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
  const publicProvider = (
    provider: typeof providerConnections.$inferSelect
  ) => ({
    ...provider,
    models: listProviderModels(provider.id),
  })

  app.get("/api/settings", (c) => c.json(publicSettings()))

  app.patch("/api/settings", validateJson(runtimeSettingsInput), (c) => {
    const input = c.req.valid("json")
    const defaultModel = input.defaultModelId
      ? db
          .select()
          .from(providerModels)
          .where(eq(providerModels.id, input.defaultModelId))
          .get()
      : undefined
    if (input.defaultModelId && !defaultModel) {
      return c.json(
        { error: { code: "not_found", message: "Default model not found" } },
        404
      )
    }
    db.update(settings)
      .set({
        defaultModelId: input.defaultModelId,
        environment: input.environment,
        containerImage: input.containerImage.trim(),
        cpuLimit: Math.round(input.cpus * 1000),
        memoryMb: input.memoryMb,
        pidsLimit: input.pidsLimit,
        maxConcurrency: input.maxConcurrency,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(settings.id, 1))
      .run()
    options.setMaxConcurrency(input.maxConcurrency)
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
      db.update(settings)
        .set({ ...input, updatedAt: new Date().toISOString() })
        .where(eq(settings.id, 1))
        .run()
      return c.json(publicSettings())
    }
  )

  app.get("/api/providers", (c) =>
    c.json({
      items: db
        .select()
        .from(providerConnections)
        .orderBy(providerConnections.createdAt)
        .all()
        .map(publicProvider),
    })
  )

  app.post("/api/providers", validateJson(providerInput), (c) => {
    const input = c.req.valid("json")
    try {
      const now = new Date().toISOString()
      const provider = {
        id: crypto.randomUUID(),
        label: input.label.trim(),
        type: input.type,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        apiKey: input.apiKey,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      }
      if (!provider.label) {
        return c.json(
          {
            error: {
              code: "invalid_provider",
              message: "Provider name is required",
            },
          },
          400
        )
      }
      db.insert(providerConnections).values(provider).run()
      syncModels()
      return c.json(publicProvider(provider), 201)
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_base_url",
            message: "Invalid provider endpoint",
          },
        },
        400
      )
    }
  })

  app.patch(
    "/api/providers/:providerId",
    validateJson(providerUpdateInput),
    (c) => {
      const existing = getProvider(c.req.param("providerId"))
      if (!existing) {
        return c.json(
          { error: { code: "not_found", message: "Provider not found" } },
          404
        )
      }
      const input = c.req.valid("json")
      try {
        const next = {
          label:
            input.label === undefined ? existing.label : input.label.trim(),
          type: input.type ?? existing.type,
          baseUrl:
            input.baseUrl === undefined
              ? existing.baseUrl
              : normalizeBaseUrl(input.baseUrl),
          apiKey: input.apiKey ?? existing.apiKey,
          enabled: input.enabled ?? existing.enabled,
          updatedAt: new Date().toISOString(),
        }
        if (!next.label) {
          return c.json(
            {
              error: {
                code: "invalid_provider",
                message: "Provider name is required",
              },
            },
            400
          )
        }
        db.update(providerConnections)
          .set(next)
          .where(eq(providerConnections.id, existing.id))
          .run()
        syncModels()
        return c.json(publicProvider({ ...existing, ...next }))
      } catch {
        return c.json(
          {
            error: {
              code: "invalid_base_url",
              message: "Invalid provider endpoint",
            },
          },
          400
        )
      }
    }
  )

  app.delete("/api/providers/:providerId", (c) => {
    const provider = getProvider(c.req.param("providerId"))
    if (!provider) {
      return c.json(
        { error: { code: "not_found", message: "Provider not found" } },
        404
      )
    }
    const defaultModelId = getSettings().defaultModelId
    if (
      defaultModelId &&
      listProviderModels(provider.id).some(
        (model) => model.id === defaultModelId
      )
    ) {
      db.update(settings)
        .set({ defaultModelId: null, updatedAt: new Date().toISOString() })
        .where(eq(settings.id, 1))
        .run()
    }
    db.delete(providerConnections)
      .where(eq(providerConnections.id, provider.id))
      .run()
    syncModels()
    return c.body(null, 204)
  })

  app.post(
    "/api/providers/:providerId/models",
    validateJson(modelInput),
    (c) => {
      const provider = getProvider(c.req.param("providerId"))
      if (!provider) {
        return c.json(
          { error: { code: "not_found", message: "Provider not found" } },
          404
        )
      }
      const input = c.req.valid("json")
      const modelId = input.modelId.trim()
      const label = input.label.trim()
      if (!modelId || !label) {
        return c.json(
          {
            error: {
              code: "invalid_model",
              message: "Model ID and name are required",
            },
          },
          400
        )
      }
      const duplicate = listProviderModels(provider.id).find(
        (model) => model.modelId === modelId
      )
      if (duplicate) {
        return c.json(
          {
            error: { code: "duplicate_model", message: "Model already exists" },
          },
          409
        )
      }
      const now = new Date().toISOString()
      const model = {
        id: crypto.randomUUID(),
        providerId: provider.id,
        modelId,
        label,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(providerModels).values(model).run()
      syncModels()
      return c.json(model, 201)
    }
  )

  app.patch(
    "/api/provider-models/:modelId",
    validateJson(modelUpdateInput),
    (c) => {
      const model = db
        .select()
        .from(providerModels)
        .where(eq(providerModels.id, c.req.param("modelId")))
        .get()
      if (!model) {
        return c.json(
          { error: { code: "not_found", message: "Model not found" } },
          404
        )
      }
      const input = c.req.valid("json")
      const label = input.label === undefined ? model.label : input.label.trim()
      if (!label) {
        return c.json(
          {
            error: { code: "invalid_model", message: "Model name is required" },
          },
          400
        )
      }
      const next = {
        label,
        enabled: input.enabled ?? model.enabled,
        updatedAt: new Date().toISOString(),
      }
      db.update(providerModels)
        .set(next)
        .where(eq(providerModels.id, model.id))
        .run()
      syncModels()
      return c.json({ ...model, ...next })
    }
  )

  app.delete("/api/provider-models/:modelId", (c) => {
    const model = db
      .select()
      .from(providerModels)
      .where(eq(providerModels.id, c.req.param("modelId")))
      .get()
    if (!model) {
      return c.json(
        { error: { code: "not_found", message: "Model not found" } },
        404
      )
    }
    if (getSettings().defaultModelId === model.id) {
      db.update(settings)
        .set({ defaultModelId: null, updatedAt: new Date().toISOString() })
        .where(eq(settings.id, 1))
        .run()
    }
    db.delete(providerModels).where(eq(providerModels.id, model.id)).run()
    syncModels()
    return c.body(null, 204)
  })

  app.post("/api/providers/:providerId/models/discover", async (c) => {
    const provider = getProvider(c.req.param("providerId"))
    if (!provider) {
      return c.json(
        { error: { code: "not_found", message: "Provider not found" } },
        404
      )
    }
    try {
      const headers: Record<string, string> =
        provider.type === "anthropic-messages"
          ? {
              "anthropic-version": "2023-06-01",
              "x-api-key": provider.apiKey,
            }
          : { Authorization: `Bearer ${provider.apiKey}` }
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error("Provider model request failed")
      const body = (await response.json()) as {
        data?: Array<{ id?: string }>
        models?: Array<{ id?: string } | string>
      }
      const source = body.data ?? body.models ?? []
      const models = source
        .map((model) => (typeof model === "string" ? model : model.id))
        .filter((model): model is string => Boolean(model))
      return c.json({ models: [...new Set(models)].sort() })
    } catch {
      return c.json(
        {
          error: {
            code: "provider_unavailable",
            message: "Could not fetch provider models",
          },
        },
        502
      )
    }
  })
}
