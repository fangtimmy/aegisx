import { modelAddress, parseModelRef } from "@aegisx/shared"
import type { ModelOption } from "@aegisx/shared/domain"
import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
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
import { responseJson } from "../lib/guards"
import { ProviderTypeSchema } from "../lib/schemas"
import {
  builtinModelProfile,
  builtinModelProfiles,
  normalizeModelMetadata,
  parseModelMetadata,
  providerApi,
  supportedThinkingLevels,
} from "./builtin-models"
import { getProviderConnections } from "./public"
import { type UpstreamApi, pumpUpstreamSse } from "./upstream-sse"

const providerInput = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 100 }),
    type: ProviderTypeSchema,
    baseUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
    exactEndpoint: Type.Optional(Type.Boolean()),
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

const providerTestInput = Type.Object(
  {
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    prompt: Type.String({ minLength: 1, maxLength: 8_000 }),
  },
  { additionalProperties: false }
)

const modelUpdateInput = Type.Partial(
  Type.Object(
    {
      label: Type.String({ minLength: 1, maxLength: 200 }),
      enabled: Type.Boolean(),
      metadata: Type.Unknown(),
    },
    { additionalProperties: false }
  ),
  { additionalProperties: false }
)

const importInput = Type.Object(
  {
    providerId: Type.String({ minLength: 1, maxLength: 200 }),
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false }
)

function cloneProviders(store: ConfigStore): ProviderData[] {
  return store.getProviders().map((p) => ({
    ...p,
    models: p.models.map((m) => ({ ...m })),
  }))
}

/** Field hygiene shared by provider create (POST) and update (PATCH): each
 * cleaner returns the sanitized value or the error reply payload. */
type ProviderFieldError = {
  code: "invalid_provider" | "invalid_base_url"
  message: string
}

function cleanApiKey(apiKey: string): { value: string } | ProviderFieldError {
  return apiKey.startsWith("$")
    ? {
        code: "invalid_provider",
        message: "apiKey must be a literal key (no $ENV references)",
      }
    : { value: apiKey }
}

function cleanBaseUrl(baseUrl: string): { value: string } | ProviderFieldError {
  try {
    return { value: normalizeHttpBaseUrl(baseUrl) }
  } catch {
    return { code: "invalid_base_url", message: "Invalid provider endpoint" }
  }
}

function findProvider(providers: ProviderData[], id: string) {
  return providers.find((p) => p.id === id)
}

/** Wire address for a provider-side call (discover / test dialogue). An
 * exact-endpoint gateway's baseUrl already IS the complete upstream URL, so
 * the standard API suffix must not be appended — the request goes there
 * verbatim, the same way /api/llm-relay forwards agent traffic. */
function wireUrl(provider: ProviderData, suffix: string): string {
  return provider.exactEndpoint
    ? provider.baseUrl
    : `${provider.baseUrl}${suffix}`
}

function findModel(provider: ProviderData, modelId: string) {
  return provider.models.find((m) => m.id === modelId)
}

/** Deletion hygiene: drop the global default-model ref when it points at
 * the provider (any model) or at one specific model being removed. */
function clearDefaultModelRef(
  store: ConfigStore,
  provider: ProviderData,
  model?: ProviderModelData
): void {
  const parsed = parseModelRef(store.getSettings()["agent.defaultModelRef"])
  if (parsed?.kind !== "model") return
  const ref = `${parsed.providerKey}/${parsed.modelId}`
  const hit =
    model !== undefined
      ? modelAddress(provider, model) === ref
      : provider.models.some((m) => modelAddress(provider, m) === ref)
  if (hit) store.updateSettings({ "agent.defaultModelRef": null })
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
    metadataSource: model.metadataSource,
    thinkingLevels: supportedThinkingLevels(parsedMetadata),
  }
}

function publicProvider(provider: ProviderData) {
  return {
    id: provider.id,
    label: provider.label,
    type: provider.type,
    baseUrl: provider.baseUrl,
    exactEndpoint: provider.exactEndpoint,
    apiKey: provider.apiKey,
    enabled: provider.enabled,
    models: provider.models.map((m) => ({
      ...publicModel(m),
      providerId: provider.id,
    })),
  }
}

export function registerProviderRoutes(
  app: Hono,
  options: { configStore: ConfigStore }
) {
  const { configStore } = options

  app.get("/api/providers", (c) =>
    c.json({
      items: configStore.getProviders().map(publicProvider),
    })
  )

  // Flat model list for ref selectors: one entry per currently-selectable
  // model (enabled provider + apiKey × enabled model), address precomputed.
  app.get("/api/models", (c) => {
    const items: ModelOption[] = []
    for (const provider of getProviderConnections(configStore)) {
      if (!provider.enabled || !provider.apiKey) continue
      for (const model of provider.models) {
        if (!model.enabled) continue
        items.push({
          address: modelAddress(provider, model),
          label: model.label,
          providerLabel: provider.label,
          thinkingLevels: model.thinkingLevels,
        })
      }
    }
    return c.json({ items })
  })

  app.get("/api/providers/:providerId/models/builtins", (c) => {
    const provider = findProvider(
      configStore.getProviders(),
      c.req.param("providerId")
    )
    if (!provider) return notFound(c, "Provider not found")
    // Only models speaking the provider's wire dialect are importable here —
    // an anthropic-messages endpoint can't serve an openai-completions model.
    const api = providerApi(provider.type)
    return c.json({
      items: builtinModelProfiles()
        .filter((model) => model.api === api)
        .map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId,
          name: model.name,
          metadata: model.metadata,
        })),
    })
  })

  app.post("/api/providers", validateJson(providerInput), (c) => {
    const input = c.req.valid("json")
    const apiKey = cleanApiKey(input.apiKey)
    if ("code" in apiKey) return badRequest(c, apiKey.code, apiKey.message)
    const baseUrl = cleanBaseUrl(input.baseUrl)
    if ("code" in baseUrl) return badRequest(c, baseUrl.code, baseUrl.message)
    const label = input.label.trim()
    if (!label) {
      return badRequest(c, "invalid_provider", "Provider name is required")
    }
    const provider: ProviderData = {
      id: crypto.randomUUID(),
      label,
      type: input.type,
      baseUrl: baseUrl.value,
      exactEndpoint: input.exactEndpoint === true,
      apiKey: apiKey.value,
      enabled: input.enabled,
      models: [],
    }
    const providers = cloneProviders(configStore)
    providers.push(provider)
    configStore.updateProviders(providers)
    return c.json(publicProvider(provider), 201)
  })

  app.patch(
    "/api/providers/:providerId",
    validateJson(providerUpdateInput),
    (c) => {
      const providers = cloneProviders(configStore)
      const existing = findProvider(providers, c.req.param("providerId"))
      if (!existing) return notFound(c, "Provider not found")
      const input = c.req.valid("json")
      if (input.baseUrl !== undefined) {
        const baseUrl = cleanBaseUrl(input.baseUrl)
        if ("code" in baseUrl) {
          return badRequest(c, baseUrl.code, baseUrl.message)
        }
        existing.baseUrl = baseUrl.value
      }
      if (input.exactEndpoint !== undefined) {
        existing.exactEndpoint = input.exactEndpoint
      }
      if (input.label !== undefined) existing.label = input.label.trim()
      if (input.type !== undefined) existing.type = input.type
      if (input.apiKey !== undefined) {
        const apiKey = cleanApiKey(input.apiKey)
        if ("code" in apiKey) {
          return badRequest(c, apiKey.code, apiKey.message)
        }
        existing.apiKey = apiKey.value
      }
      if (input.enabled !== undefined) existing.enabled = input.enabled
      if (!existing.label) {
        return badRequest(c, "invalid_provider", "Provider name is required")
      }
      configStore.updateProviders(providers)
      return c.json(publicProvider(existing))
    }
  )

  app.delete("/api/providers/:providerId", (c) => {
    const providers = cloneProviders(configStore)
    const idx = providers.findIndex((p) => p.id === c.req.param("providerId"))
    if (idx === -1) return notFound(c, "Provider not found")
    clearDefaultModelRef(configStore, providers[idx])
    providers.splice(idx, 1)
    configStore.updateProviders(providers)
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
      const modelId = input.modelId.trim()
      const label = input.label.trim()
      if (!modelId || !label) {
        return badRequest(c, "invalid_model", "Model ID and name are required")
      }
      if (provider.models.some((m) => m.modelId === modelId)) {
        return conflict(c, "duplicate_model", "Model already exists")
      }
      let metadata: string
      try {
        metadata = JSON.stringify(normalizeModelMetadata(input.metadata ?? {}))
      } catch (error) {
        return badRequest(
          c,
          "invalid_model_metadata",
          error instanceof Error ? error.message : "Invalid model metadata"
        )
      }
      const model: ProviderModelData = {
        id: crypto.randomUUID(),
        modelId,
        label,
        enabled: true,
        metadata,
        metadataSource: null,
      }
      provider.models.push(model)
      configStore.updateProviders(providers)
      return c.json({ ...publicModel(model), providerId: provider.id }, 201)
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
      if (input.label !== undefined) {
        model.label = input.label.trim()
        if (!model.label) {
          return badRequest(c, "invalid_model", "Model name is required")
        }
      }
      if (input.enabled !== undefined) model.enabled = input.enabled
      if (input.metadata !== undefined) {
        let metadata: string
        try {
          metadata = JSON.stringify(normalizeModelMetadata(input.metadata))
        } catch (error) {
          return badRequest(
            c,
            "invalid_model_metadata",
            error instanceof Error ? error.message : "Invalid model metadata"
          )
        }
        model.metadata = metadata
        // A hand-written metadata edit takes ownership of the metadata.
        model.metadataSource = null
      }
      configStore.updateProviders(providers)
      return c.json({ ...publicModel(model), providerId: provider.id })
    }
  )

  // Copy a pi builtin profile's metadata onto the model (one-shot import —
  // the copy is editable afterwards; repeating the call re-syncs it).
  app.post(
    "/api/provider-models/:modelId/import",
    validateJson(importInput),
    (c) => {
      const providers = cloneProviders(configStore)
      const { provider, model } = findProviderModel(
        providers,
        c.req.param("modelId")
      )
      if (!provider || !model) return notFound(c, "Model not found")
      const input = c.req.valid("json")
      const profile = builtinModelProfile(input.providerId, input.modelId)
      if (!profile) {
        return badRequest(c, "invalid_pi_model", "Pi model is unavailable")
      }
      model.metadata = JSON.stringify(profile.metadata)
      model.metadataSource = `pi:${profile.providerId}/${profile.modelId}`
      configStore.updateProviders(providers)
      return c.json({ ...publicModel(model), providerId: provider.id })
    }
  )

  app.delete("/api/provider-models/:modelId", (c) => {
    const providers = cloneProviders(configStore)
    const { provider, model } = findProviderModel(
      providers,
      c.req.param("modelId")
    )
    if (!provider || !model) return notFound(c, "Model not found")
    clearDefaultModelRef(configStore, provider, model)
    provider.models = provider.models.filter((m) => m.id !== model.id)
    configStore.updateProviders(providers)
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
      const url =
        provider.type === "anthropic-messages"
          ? wireUrl(provider, "/v1/models")
          : wireUrl(provider, "/models")
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      })
      if (!response.ok) {
        const upstreamBody = await response.text().catch(() => "")
        throw new Error(`${response.status} ${upstreamBody.slice(0, 200)}`)
      }
      const body = await responseJson<{
        data?: Array<{ id?: string }>
        models?: Array<{ id?: string } | string>
      }>(response)
      const source = body.data ?? body.models ?? []
      const models = source
        .map((model) => (typeof model === "string" ? model : model.id))
        .filter((model): model is string => Boolean(model))
      return c.json({ models: [...new Set(models)].toSorted() })
    } catch (cause) {
      return jsonError(
        c,
        {
          code: "provider_unavailable",
          message: `Could not fetch provider models: ${
            cause instanceof Error && cause.message
              ? cause.message
              : String(cause)
          }`.slice(0, 300),
        },
        502
      )
    }
  })

  /** Test dialogue (SSE): one streaming chat request against the provider
   * with the given model — a bare user message, no system prompt / tools.
   * Events pushed to the client: {type:"delta",text} per text chunk,
   * {type:"done",usage?} at the end, {type:"error",message} mid-stream or
   * when the upstream ends without a terminal frame.
   * Connection-level failures (bad key / unknown model / timeout) return
   * 502 provider_unavailable with the upstream status + truncated body in
   * the message before the stream even starts. */
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
      const isResponses = provider.type === "openai-responses"
      const headers: Record<string, string> = isAnthropic
        ? {
            "anthropic-version": "2023-06-01",
            "x-api-key": provider.apiKey,
          }
        : { Authorization: `Bearer ${provider.apiKey}` }
      const [url, body] = isAnthropic
        ? [
            wireUrl(provider, "/v1/messages"),
            {
              model: input.modelId,
              stream: true,
              max_tokens: 1024,
              messages: [{ role: "user", content: input.prompt }],
            },
          ]
        : isResponses
          ? [
              wireUrl(provider, "/responses"),
              { model: input.modelId, stream: true, input: input.prompt },
            ]
          : [
              wireUrl(provider, "/chat/completions"),
              {
                model: input.modelId,
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: "user", content: input.prompt }],
              },
            ]

      const controller = new AbortController()
      // Overall timeout for the connect phase (time to first chunk); from the
      // first chunk on it doubles as an idle budget, re-armed per chunk.
      let timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        timeout
      )
      const rearmTimer = () => {
        clearTimeout(timer)
        timer = setTimeout(
          () => controller.abort(new Error("timeout")),
          timeout
        )
      }
      let response: Response
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (cause) {
        clearTimeout(timer)
        const timedOut =
          controller.signal.aborted &&
          controller.signal.reason instanceof Error &&
          controller.signal.reason.message === "timeout"
        return jsonError(
          c,
          {
            code: "provider_unavailable",
            message: timedOut
              ? `Provider test failed (timeout after ${timeout}ms)`
              : `Provider test failed: ${
                  cause instanceof Error && cause.message
                    ? cause.message
                    : String(cause)
                }`.slice(0, 300),
          },
          502
        )
      }
      if (!response.ok || !response.body) {
        const upstreamBody = await response.text().catch(() => "")
        clearTimeout(timer)
        return jsonError(
          c,
          {
            code: "provider_unavailable",
            message: `Provider test failed: ${response.status} ${upstreamBody.slice(0, 200)}`,
          },
          502
        )
      }

      const api: UpstreamApi = isAnthropic
        ? "anthropic"
        : isResponses
          ? "responses"
          : "openai"
      return streamSSE(c, async (stream) => {
        stream.onAbort(() => controller.abort())
        const send = (event: Record<string, unknown>) =>
          stream.writeSSE({ data: JSON.stringify(event) })
        try {
          const { usage, terminated } = await pumpUpstreamSse(
            response.body!,
            api,
            (text) => send({ type: "delta", text }),
            rearmTimer
          )
          if (terminated) {
            await send({ type: "done", ...(usage ? { usage } : {}) })
          } else {
            // Upstream closed its side without a terminal frame ([DONE] /
            // message_stop / response.completed) — a truncated reply, not a
            // complete one.
            await send({
              type: "error",
              message: "Provider stream ended without a completion frame",
              ...(usage ? { usage } : {}),
            })
          }
        } catch (cause) {
          await send({
            type: "error",
            message:
              cause instanceof Error && cause.message
                ? cause.message
                : "Provider test failed",
          })
        } finally {
          clearTimeout(timer)
        }
      })
    }
  )
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
