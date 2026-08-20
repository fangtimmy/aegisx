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
import {
  builtinModelProfile,
  builtinModelProfiles,
  normalizeModelMetadata,
  parseModelMetadata,
  supportedThinkingLevels,
} from "./builtin-models"
import { getProviderConnections } from "./public"

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
    return c.json({
      items: builtinModelProfiles().map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        name: model.name,
        metadata: model.metadata,
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
    const defaultModelRef = settings["agent.defaultModelRef"]
    const parsedDefault = parseModelRef(defaultModelRef)
    if (
      parsedDefault?.kind === "model" &&
      provider.models.some(
        (m) =>
          modelAddress(provider, m) ===
          `${parsedDefault.providerKey}/${parsedDefault.modelId}`
      )
    ) {
      configStore.updateSettings({ "agent.defaultModelRef": null })
    }
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
          metadataSource: null,
        }
        provider.models.push(model)
        configStore.updateProviders(providers)
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
        if (input.metadata !== undefined) {
          model.metadata = JSON.stringify(
            normalizeModelMetadata(input.metadata)
          )
          // A hand-written metadata edit takes ownership of the metadata.
          model.metadataSource = null
        }
        configStore.updateProviders(providers)
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
    const settings = configStore.getSettings()
    const parsedDefault = parseModelRef(settings["agent.defaultModelRef"])
    if (
      parsedDefault?.kind === "model" &&
      modelAddress(provider, model) ===
        `${parsedDefault.providerKey}/${parsedDefault.modelId}`
    ) {
      configStore.updateSettings({ "agent.defaultModelRef": null })
    }
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

  /** Test dialogue (SSE): one streaming chat request against the provider
   * with the given model — a bare user message, no system prompt / tools.
   * Events pushed to the client: {type:"delta",text} per text chunk,
   * {type:"done",usage?} at the end, {type:"error",message} mid-stream.
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
            `${provider.baseUrl}/v1/messages`,
            {
              model: input.modelId,
              stream: true,
              max_tokens: 1024,
              messages: [{ role: "user", content: input.prompt }],
            },
          ]
        : isResponses
          ? [
              `${provider.baseUrl}/responses`,
              { model: input.modelId, stream: true, input: input.prompt },
            ]
          : [
              `${provider.baseUrl}/chat/completions`,
              {
                model: input.modelId,
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: "user", content: input.prompt }],
              },
            ]

      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        timeout
      )
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
      } catch {
        clearTimeout(timer)
        return jsonError(
          c,
          {
            code: "provider_unavailable",
            message: `Provider test failed (timeout after ${timeout}ms)`,
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

      const api = isAnthropic
        ? "anthropic"
        : isResponses
          ? "responses"
          : "openai"
      return streamSSE(c, async (stream) => {
        stream.onAbort(() => controller.abort())
        const send = (event: Record<string, unknown>) =>
          stream.writeSSE({ data: JSON.stringify(event) })
        try {
          const usage = await pumpUpstreamSse(response.body!, api, (text) =>
            send({ type: "delta", text })
          )
          await send({ type: "done", ...(usage ? { usage } : {}) })
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

type UpstreamApi = "anthropic" | "openai" | "responses"

type TestUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Merge a partial usage readout into the accumulator (later events refine
 * earlier ones, e.g. anthropic message_delta's final output_tokens). */
function mergeUsage(
  usage: TestUsage | undefined,
  patch: Partial<TestUsage>
): TestUsage {
  return {
    input: patch.input ?? usage?.input ?? 0,
    output: patch.output ?? usage?.output ?? 0,
    cacheRead: patch.cacheRead ?? usage?.cacheRead ?? 0,
    cacheWrite: patch.cacheWrite ?? usage?.cacheWrite ?? 0,
  }
}

/** Interpret one upstream SSE `data:` payload for the test proxy — return
 * the text delta (if any) and the refined usage accumulator. */
function handleUpstreamEvent(
  api: UpstreamApi,
  raw: string,
  usage: TestUsage | undefined
): { usage: TestUsage | undefined; delta: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { usage, delta: "" }
  }
  if (!parsed || typeof parsed !== "object") return { usage, delta: "" }
  const event = parsed as Record<string, unknown>

  if (api === "anthropic") {
    if (event.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { usage, delta: delta.text }
      }
    } else if (event.type === "message_start") {
      const u = (event.message as Record<string, unknown> | undefined)?.usage
      if (u && typeof u === "object") {
        const d = u as Record<string, unknown>
        usage = mergeUsage(usage, {
          input: num(d.input_tokens),
          output: num(d.output_tokens),
          cacheRead: num(d.cache_read_input_tokens),
          cacheWrite: num(d.cache_creation_input_tokens),
        })
      }
    } else if (event.type === "message_delta") {
      const u = event.usage as Record<string, unknown> | undefined
      if (u) usage = mergeUsage(usage, { output: num(u.output_tokens) })
    }
    return { usage, delta: "" }
  }

  if (api === "openai") {
    const choices = event.choices as Array<Record<string, unknown>> | undefined
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
    const text =
      typeof delta?.content === "string" && delta.content ? delta.content : ""
    const u = event.usage as Record<string, unknown> | undefined
    if (u) {
      const details = u.prompt_tokens_details as
        | Record<string, unknown>
        | undefined
      usage = mergeUsage(usage, {
        input: num(u.prompt_tokens),
        output: num(u.completion_tokens),
        cacheRead: num(details?.cached_tokens),
      })
    }
    return { usage, delta: text }
  }

  if (event.type === "response.output_text.delta") {
    if (typeof event.delta === "string" && event.delta)
      return { usage, delta: event.delta }
  } else if (event.type === "response.completed") {
    const response = event.response as Record<string, unknown> | undefined
    const u = response?.usage as Record<string, unknown> | undefined
    if (u) {
      const details = u.input_tokens_details as
        | Record<string, unknown>
        | undefined
      usage = mergeUsage(usage, {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(details?.cached_tokens),
      })
    }
  }
  return { usage, delta: "" }
}

/** Read an upstream SSE body (text/event-stream), invoking `onDelta` per
 * text chunk and returning the final token usage when the stream reports
 * one. Minimal framing: splits events on blank lines, joins multi-line
 * `data:` fields. */
async function pumpUpstreamSse(
  body: ReadableStream<Uint8Array>,
  api: UpstreamApi,
  onDelta: (text: string) => Promise<void> | void
): Promise<TestUsage | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: TestUsage | undefined

  const drainBlock = async (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data || data === "[DONE]") return
    const result = handleUpstreamEvent(api, data, usage)
    usage = result.usage
    if (result.delta) await onDelta(result.delta)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(
      /\r\n/g,
      "\n"
    )
    let index: number
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      await drainBlock(block)
    }
  }
  if (buffer.trim()) await drainBlock(buffer.replace(/\r/g, ""))
  return usage
}
