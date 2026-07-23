import type { Hono } from "hono"
import { Type } from "typebox"
import type {
  ConfigStore,
  ProviderData,
  ProviderModelData,
} from "../infrastructure/config-store"
import { notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  builtinModelProfile,
  builtinModelProfiles,
  normalizeModelMetadata,
  parseModelMetadata,
  supportedThinkingLevels,
} from "./models"

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

function cloneProviders(store: ConfigStore): ProviderData[] {
  return store.getProviders().map((p) => ({
    ...p,
    models: p.models.map((m) => ({ ...m })),
  }))
}

function findProvider(providers: ProviderData[], id: string) {
  return providers.find((p) => p.id === id)
}

function findModel(provider: ProviderData, modelId: string) {
  return provider.models.find((m) => m.id === modelId)
}

function publicModel(model: ProviderModelData) {
  const parsedMetadata = parseModelMetadata(model.metadata)
  return {
    id: model.id,
    providerId: "",
    modelId: model.modelId,
    label: model.label,
    enabled: model.enabled,
    metadata: parsedMetadata,
    piBinding:
      model.piProviderId && model.piModelId
        ? { providerId: model.piProviderId, modelId: model.piModelId }
        : null,
    thinkingLevels: supportedThinkingLevels(parsedMetadata),
    createdAt: "",
    updatedAt: "",
  }
}

function publicProvider(provider: ProviderData) {
  return {
    id: provider.id,
    label: provider.label,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    enabled: provider.enabled,
    createdAt: "",
    updatedAt: "",
    models: provider.models.map((m) => ({
      ...publicModel(m),
      providerId: provider.id,
    })),
  }
}

export function registerProviderRoutes(
  app: Hono,
  options: {
    configStore: ConfigStore
    syncModels(): void
  }
) {
  const { configStore, syncModels } = options

  app.get("/api/providers", (c) =>
    c.json({
      items: configStore.getProviders().map(publicProvider),
    })
  )

  app.get("/api/providers/:providerId/models/builtins", (c) => {
    const provider = findProvider(
      configStore.getProviders(),
      c.req.param("providerId")
    )
    if (!provider) return notFound(c, "Provider not found")
    return c.json({
      items: builtinModelProfiles().map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        name: model.name,
      })),
    })
  })

  app.post("/api/providers", validateJson(providerInput), (c) => {
    const input = c.req.valid("json")
    try {
      const provider: ProviderData = {
        id: crypto.randomUUID(),
        label: input.label.trim(),
        type: input.type,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        apiKey: input.apiKey,
        enabled: input.enabled,
        models: [],
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
      const providers = cloneProviders(configStore)
      providers.push(provider)
      configStore.updateProviders(providers)
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
      const providers = cloneProviders(configStore)
      const existing = findProvider(providers, c.req.param("providerId"))
      if (!existing) return notFound(c, "Provider not found")
      const input = c.req.valid("json")
      try {
        if (input.label !== undefined) existing.label = input.label.trim()
        if (input.type !== undefined) existing.type = input.type
        if (input.baseUrl !== undefined)
          existing.baseUrl = normalizeBaseUrl(input.baseUrl)
        if (input.apiKey !== undefined) existing.apiKey = input.apiKey
        if (input.enabled !== undefined) existing.enabled = input.enabled
        if (!existing.label) {
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
        configStore.updateProviders(providers)
        syncModels()
        return c.json(publicProvider(existing))
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
    const providers = cloneProviders(configStore)
    const idx = providers.findIndex((p) => p.id === c.req.param("providerId"))
    if (idx === -1) return notFound(c, "Provider not found")
    const provider = providers[idx]
    const settings = configStore.getSettings()
    if (
      settings.defaultModelId &&
      provider.models.some((m) => m.id === settings.defaultModelId)
    ) {
      configStore.updateSettings({ defaultModelId: null })
    }
    providers.splice(idx, 1)
    configStore.updateProviders(providers)
    syncModels()
    return c.body(null, 204)
  })

  app.post(
    "/api/providers/:providerId/models",
    validateJson(modelInput),
    (c) => {
      const providers = cloneProviders(configStore)
      const provider = findProvider(providers, c.req.param("providerId"))
      if (!provider) return notFound(c, "Provider not found")
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
        if (provider.models.some((m) => m.modelId === modelId)) {
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
        const model: ProviderModelData = {
          id: crypto.randomUUID(),
          modelId,
          label,
          enabled: true,
          metadata: JSON.stringify(
            normalizeModelMetadata(input.metadata ?? {})
          ),
          piProviderId: null,
          piModelId: null,
        }
        provider.models.push(model)
        configStore.updateProviders(providers)
        syncModels()
        return c.json({ ...publicModel(model), providerId: provider.id }, 201)
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
      const providers = cloneProviders(configStore)
      const { provider, model } = findProviderModel(
        providers,
        c.req.param("modelId")
      )
      if (!provider || !model) return notFound(c, "Model not found")
      const input = c.req.valid("json")
      try {
        if (input.label !== undefined) {
          model.label = input.label.trim()
          if (!model.label) {
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
        }
        if (input.enabled !== undefined) model.enabled = input.enabled
        if (input.metadata !== undefined) {
          const profile = input.binding
            ? builtinModelProfile(
                input.binding.providerId,
                input.binding.modelId
              )
            : undefined
          if (input.binding && !profile) {
            return c.json(
              {
                error: {
                  code: "invalid_pi_model",
                  message: "Pi model binding is unavailable",
                },
              },
              400
            )
          }
          model.metadata = JSON.stringify(
            profile?.metadata ?? normalizeModelMetadata(input.metadata)
          )
        }
        if (input.binding !== undefined) {
          if (input.binding) {
            const profile = builtinModelProfile(
              input.binding.providerId,
              input.binding.modelId
            )
            if (!profile) {
              return c.json(
                {
                  error: {
                    code: "invalid_pi_model",
                    message: "Pi model binding is unavailable",
                  },
                },
                400
              )
            }
            model.metadata = JSON.stringify(profile.metadata)
            model.piProviderId = profile.providerId
            model.piModelId = profile.modelId
          } else {
            model.piProviderId = null
            model.piModelId = null
          }
        }
        configStore.updateProviders(providers)
        syncModels()
        return c.json({ ...publicModel(model), providerId: provider.id })
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
      const providers = cloneProviders(configStore)
      const { provider, model } = findProviderModel(
        providers,
        c.req.param("modelId")
      )
      if (!provider || !model) return notFound(c, "Model not found")
      const binding = c.req.valid("json")
      const profile = builtinModelProfile(binding.providerId, binding.modelId)
      if (!profile) {
        return c.json(
          {
            error: {
              code: "invalid_pi_model",
              message: "Pi model binding is unavailable",
            },
          },
          400
        )
      }
      model.metadata = JSON.stringify(profile.metadata)
      model.piProviderId = profile.providerId
      model.piModelId = profile.modelId
      configStore.updateProviders(providers)
      syncModels()
      return c.json({ ...publicModel(model), providerId: provider.id })
    }
  )

  app.delete("/api/provider-models/:modelId/binding", (c) => {
    const providers = cloneProviders(configStore)
    const { provider, model } = findProviderModel(
      providers,
      c.req.param("modelId")
    )
    if (!provider || !model) return notFound(c, "Model not found")
    model.piProviderId = null
    model.piModelId = null
    configStore.updateProviders(providers)
    syncModels()
    return c.json({ ...publicModel(model), providerId: provider.id })
  })

  app.delete("/api/provider-models/:modelId", (c) => {
    const providers = cloneProviders(configStore)
    const { provider, model } = findProviderModel(
      providers,
      c.req.param("modelId")
    )
    if (!provider || !model) return notFound(c, "Model not found")
    const settings = configStore.getSettings()
    if (settings.defaultModelId === model.id) {
      configStore.updateSettings({ defaultModelId: null })
    }
    provider.models = provider.models.filter((m) => m.id !== model.id)
    configStore.updateProviders(providers)
    syncModels()
    return c.body(null, 204)
  })

  app.post("/api/providers/:providerId/models/discover", async (c) => {
    const provider = findProvider(
      configStore.getProviders(),
      c.req.param("providerId")
    )
    if (!provider) return notFound(c, "Provider not found")
    const timeout = configStore.getSettings().providerDiscoverTimeoutMs
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
        signal: AbortSignal.timeout(timeout),
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

function findProviderModel(
  providers: ProviderData[],
  modelId: string
): {
  provider: ProviderData | undefined
  model: ProviderModelData | undefined
} {
  for (const provider of providers) {
    const model = findModel(provider, modelId)
    if (model) return { provider, model }
  }
  return { provider: undefined, model: undefined }
}
