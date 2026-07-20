import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"
import type { createDatabase } from "../db"
import { providerConnections, providerModels, settings } from "../db/schema"
import { notFound } from "../http-errors"
import { validateJson } from "../validation"
import {
  builtinModelProfile,
  builtinModelProfiles,
  normalizeModelMetadata,
  parseModelMetadata,
  providerApi,
  supportedThinkingLevels,
} from "./models"

type Database = ReturnType<typeof createDatabase>["db"]

const providerType = Type.Union([
  Type.Literal("openai-compatible"),
  Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"),
])

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
    metadata: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
)

const bindingInput = Type.Object(
  {
    providerId: Type.String({ minLength: 1, maxLength: 200 }),
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false }
)

const modelUpdateInput = Type.Partial(
  Type.Object(
    {
      label: Type.String({ minLength: 1, maxLength: 200 }),
      enabled: Type.Boolean(),
      metadata: Type.Unknown(),
      binding: Type.Union([bindingInput, Type.Null()]),
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
  }
) {
  const { db, getSettings, listProviderModels, syncModels } = options
  const getProvider = (providerId: string) =>
    db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, providerId))
      .get()
  const getModel = (modelId: string) =>
    db.select().from(providerModels).where(eq(providerModels.id, modelId)).get()
  const publicModel = (model: typeof providerModels.$inferSelect) => {
    const { metadata, piProviderId, piModelId, ...value } = model
    const parsedMetadata = parseModelMetadata(metadata)
    return {
      ...value,
      metadata: parsedMetadata,
      piBinding:
        piProviderId && piModelId
          ? { providerId: piProviderId, modelId: piModelId }
          : null,
      thinkingLevels: supportedThinkingLevels(parsedMetadata),
    }
  }
  const publicProvider = (
    provider: typeof providerConnections.$inferSelect
  ) => ({
    ...provider,
    models: listProviderModels(provider.id).map(publicModel),
  })
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

  app.get("/api/providers/:providerId/models/builtins", (c) => {
    const provider = getProvider(c.req.param("providerId"))
    if (!provider) {
      return notFound(c, "Provider not found")
    }
    return c.json({
      items: builtinModelProfiles(providerApi(provider.type)).map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        name: model.name,
      })),
    })
  })

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
        return notFound(c, "Provider not found")
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
      return notFound(c, "Provider not found")
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
        return notFound(c, "Provider not found")
      }
      const input = c.req.valid("json")
      try {
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
              error: {
                code: "duplicate_model",
                message: "Model already exists",
              },
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
          metadata: JSON.stringify(
            normalizeModelMetadata(input.metadata ?? {})
          ),
          piProviderId: null,
          piModelId: null,
          createdAt: now,
          updatedAt: now,
        }
        try {
          db.insert(providerModels).values(model).run()
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("provider_models_provider_model_unique")
          ) {
            return c.json(
              {
                error: {
                  code: "duplicate_model",
                  message: "Model already exists",
                },
              },
              409
            )
          }
          throw error
        }
        syncModels()
        return c.json(publicModel(model), 201)
      } catch (error) {
        return c.json(
          {
            error: {
              code: "invalid_model_metadata",
              message:
                error instanceof Error
                  ? error.message
                  : "Invalid model metadata",
            },
          },
          400
        )
      }
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
        return notFound(c, "Model not found")
      }
      const provider = getProvider(model.providerId)
      const input = c.req.valid("json")
      try {
        const label =
          input.label === undefined ? model.label : input.label.trim()
        if (!label) {
          return c.json(
            {
              error: {
                code: "invalid_model",
                message: "Model name is required",
              },
            },
            400
          )
        }
        const profile = input.binding
          ? builtinModelProfile(
              input.binding.providerId,
              input.binding.modelId,
              provider ? providerApi(provider.type) : ""
            )
          : undefined
        if (input.binding && !profile) {
          return c.json(
            {
              error: {
                code: "invalid_pi_model",
                message: "Pi model is unavailable for this provider protocol",
              },
            },
            400
          )
        }
        const next = {
          label,
          enabled: input.enabled ?? model.enabled,
          metadata:
            input.metadata === undefined
              ? model.metadata
              : JSON.stringify(
                  profile?.metadata ?? normalizeModelMetadata(input.metadata)
                ),
          ...(input.binding === undefined
            ? {}
            : {
                piProviderId: input.binding?.providerId ?? null,
                piModelId: input.binding?.modelId ?? null,
              }),
          updatedAt: new Date().toISOString(),
        }
        db.update(providerModels)
          .set(next)
          .where(eq(providerModels.id, model.id))
          .run()
        syncModels()
        return c.json(publicModel({ ...model, ...next }))
      } catch (error) {
        return c.json(
          {
            error: {
              code: "invalid_model_metadata",
              message:
                error instanceof Error
                  ? error.message
                  : "Invalid model metadata",
            },
          },
          400
        )
      }
    }
  )

  app.post(
    "/api/provider-models/:modelId/binding",
    validateJson(bindingInput),
    (c) => {
      const model = getModel(c.req.param("modelId"))
      const provider = model ? getProvider(model.providerId) : undefined
      if (!model || !provider) {
        return notFound(c, "Model not found")
      }
      const binding = c.req.valid("json")
      const profile = builtinModelProfile(
        binding.providerId,
        binding.modelId,
        providerApi(provider.type)
      )
      if (!profile) {
        return c.json(
          {
            error: {
              code: "invalid_pi_model",
              message: "Pi model is unavailable for this provider protocol",
            },
          },
          400
        )
      }
      const next = {
        metadata: JSON.stringify(profile.metadata),
        piProviderId: profile.providerId,
        piModelId: profile.modelId,
        updatedAt: new Date().toISOString(),
      }
      db.update(providerModels)
        .set(next)
        .where(eq(providerModels.id, model.id))
        .run()
      syncModels()
      return c.json(publicModel({ ...model, ...next }))
    }
  )

  app.delete("/api/provider-models/:modelId/binding", (c) => {
    const model = getModel(c.req.param("modelId"))
    if (!model) {
      return notFound(c, "Model not found")
    }
    const next = {
      piProviderId: null,
      piModelId: null,
      updatedAt: new Date().toISOString(),
    }
    db.update(providerModels)
      .set(next)
      .where(eq(providerModels.id, model.id))
      .run()
    syncModels()
    return c.json(publicModel({ ...model, ...next }))
  })

  app.delete("/api/provider-models/:modelId", (c) => {
    const model = db
      .select()
      .from(providerModels)
      .where(eq(providerModels.id, c.req.param("modelId")))
      .get()
    if (!model) {
      return notFound(c, "Model not found")
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
      return notFound(c, "Provider not found")
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
