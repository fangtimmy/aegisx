import { parseModelRef } from "@aegisx/shared"
import type { Hono } from "hono"
import { Type } from "typebox"

import type {
  ConfigStore,
  ProviderData,
  ProviderModelData,
} from "../infrastructure/config-store"
import {
  badRequest,
  conflict,
  jsonError,
  notFound,
} from "../infrastructure/http-errors"
import { normalizeHttpBaseUrl } from "../infrastructure/urls"
import { validateJson } from "../infrastructure/validation"
import {
  builtinModelProfile,
  builtinModelProfiles,
  normalizeModelMetadata,
  parseModelMetadata,
  supportedThinkingLevels,
} from "./builtin-models"

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

const providerTestInput = Type.Object(
  { modelId: Type.String({ minLength: 1, maxLength: 200 }) },
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
  const { configStore } = options
  // Reference through the options object (not destructured) so `this` survives.
  const syncModels = () => options.syncModels()

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
      if (input.apiKey.startsWith("$")) {
        return badRequest(
          c,
          "invalid_provider",
          "apiKey must be a literal key (no $ENV references)"
        )
      }
      const provider: ProviderData = {
        id: crypto.randomUUID(),
        label: input.label.trim(),
        type: input.type,
        baseUrl: normalizeHttpBaseUrl(input.baseUrl),
        apiKey: input.apiKey,
        enabled: input.enabled,
        models: [],
      }
      if (!provider.label) {
        return badRequest(c, "invalid_provider", "Provider name is required")
      }
      const providers = cloneProviders(configStore)
      providers.push(provider)
      configStore.updateProviders(providers)
      syncModels()
      return c.json(publicProvider(provider), 201)
    } catch {
      return badRequest(c, "invalid_base_url", "Invalid provider endpoint")
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
          existing.baseUrl = normalizeHttpBaseUrl(input.baseUrl)
        if (input.apiKey !== undefined) {
          if (input.apiKey.startsWith("$")) {
            return badRequest(
              c,
              "invalid_provider",
              "apiKey must be a literal key (no $ENV references)"
            )
          }
          existing.apiKey = input.apiKey
        }
        if (input.enabled !== undefined) existing.enabled = input.enabled
        if (!existing.label) {
          return badRequest(c, "invalid_provider", "Provider name is required")
        }
        configStore.updateProviders(providers)
        syncModels()
        return c.json(publicProvider(existing))
      } catch {
        return badRequest(c, "invalid_base_url", "Invalid provider endpoint")
      }
    }
  )

  app.delete("/api/providers/:providerId", (c) => {
    const providers = cloneProviders(configStore)
    const idx = providers.findIndex((p) => p.id === c.req.param("providerId"))
    if (idx === -1) return notFound(c, "Provider not found")
    const provider = providers[idx]
    const settings = configStore.getSettings()
    const defaultModelRef = settings["agent.defaultModelId"]
    const parsedDefault = parseModelRef(defaultModelRef)
    if (
      parsedDefault?.kind === "model" &&
      provider.models.some((m) => {
        const addr = piAddressOf(provider, m)
        return (
          addr.providerKey === parsedDefault.providerKey &&
          addr.modelId === parsedDefault.modelId
        )
      })
    ) {
      configStore.updateSettings({ "agent.defaultModelId": null })
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
          return badRequest(
            c,
            "invalid_model",
            "Model ID and name are required"
          )
        }
        if (provider.models.some((m) => m.modelId === modelId)) {
          return conflict(c, "duplicate_model", "Model already exists")
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
        return badRequest(
          c,
          "invalid_model_metadata",
          error instanceof Error ? error.message : "Invalid model metadata"
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
            return badRequest(c, "invalid_model", "Model name is required")
          }
        }
        if (input.enabled !== undefined) model.enabled = input.enabled

        // A pi model binding, when set, locks metadata to its builtin profile.
        const profile =
          input.binding &&
          builtinModelProfile(input.binding.providerId, input.binding.modelId)
        if (input.binding && !profile) {
          return badRequest(
            c,
            "invalid_pi_model",
            "Pi model binding is unavailable"
          )
        }
        if (profile) {
          model.metadata = JSON.stringify(profile.metadata)
        } else if (input.metadata !== undefined) {
          model.metadata = JSON.stringify(
            normalizeModelMetadata(input.metadata)
          )
        }
        if (input.binding !== undefined) {
          model.piProviderId = profile ? profile.providerId : null
          model.piModelId = profile ? profile.modelId : null
        }

        configStore.updateProviders(providers)
        syncModels()
        return c.json({ ...publicModel(model), providerId: provider.id })
      } catch (error) {
        return badRequest(
          c,
          "invalid_model_metadata",
          error instanceof Error ? error.message : "Invalid model metadata"
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
        return badRequest(
          c,
          "invalid_pi_model",
          "Pi model binding is unavailable"
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
    const parsedDefault = parseModelRef(settings["agent.defaultModelId"])
    if (parsedDefault?.kind === "model") {
      const addr = piAddressOf(provider, model)
      if (
        addr.providerKey === parsedDefault.providerKey &&
        addr.modelId === parsedDefault.modelId
      ) {
        configStore.updateSettings({ "agent.defaultModelId": null })
      }
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
    const timeout =
      configStore.getSettings()["runtime.providerDiscoverTimeoutMs"]
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
      return jsonError(
        c,
        {
          code: "provider_unavailable",
          message: "Could not fetch provider models",
        },
        502
      )
    }
  })

  /** Test dialogue: one max_tokens=1 chat request against the provider with
   * the given model — verifies baseUrl / apiKey / model existence in one
   * round trip. Failures return 502 provider_unavailable with the upstream
   * status + truncated body in the message (the UI result line). */
  app.post(
    "/api/providers/:providerId/test",
    validateJson(providerTestInput),
    async (c) => {
      const provider = findProvider(
        configStore.getProviders(),
        c.req.param("providerId")
      )
      if (!provider) return notFound(c, "Provider not found")
      const input = c.req.valid("json")
      const timeout =
        configStore.getSettings()["runtime.providerDiscoverTimeoutMs"]
      const isAnthropic = provider.type === "anthropic-messages"
      const headers: Record<string, string> = isAnthropic
        ? {
            "anthropic-version": "2023-06-01",
            "x-api-key": provider.apiKey,
          }
        : { Authorization: `Bearer ${provider.apiKey}` }
      const startedAt = performance.now()
      try {
        const response = await fetch(
          isAnthropic
            ? `${provider.baseUrl}/v1/messages`
            : `${provider.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              model: input.modelId,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
            signal: AbortSignal.timeout(timeout),
          }
        )
        const latencyMs = Math.round(performance.now() - startedAt)
        if (!response.ok) {
          const upstreamBody = (await response.text()).slice(0, 200)
          return jsonError(
            c,
            {
              code: "provider_unavailable",
              message: `Provider test failed: ${response.status} ${upstreamBody}`,
            },
            502
          )
        }
        return c.json({ ok: true, latencyMs })
      } catch {
        return jsonError(
          c,
          {
            code: "provider_unavailable",
            message: "Provider test failed",
          },
          502
        )
      }
    }
  )
}

/** Pi (providerKey, modelId) for a stored provider/model — mirrors
 * resolvePiModelRef over the storage shape (piProviderId/piModelId columns).
 * The default-model setting stores a canonical ref string; clearing it on
 * provider/model deletion compares against this address. */
function piAddressOf(
  provider: ProviderData,
  model: ProviderModelData
): { providerKey: string; modelId: string } {
  return model.piProviderId
    ? {
        providerKey: model.piProviderId,
        modelId: model.piModelId ?? model.modelId,
      }
    : { providerKey: `aegisx-${provider.id}`, modelId: model.modelId }
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
