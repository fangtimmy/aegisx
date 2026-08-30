import { isRecord, modelAddress, parseModelRef } from "@aegisx/shared"
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
import { optRecord, responseJson } from "../lib/guards"
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
    if (input.apiKey.startsWith("$")) {
      return badRequest(
        c,
        "invalid_provider",
        "apiKey must be a literal key (no $ENV references)"
      )
    }
    let baseUrl: string
    try {
      baseUrl = normalizeHttpBaseUrl(input.baseUrl)
    } catch {
      return badRequest(c, "invalid_base_url", "Invalid provider endpoint")
    }
    const provider: ProviderData = {
      id: crypto.randomUUID(),
      label: input.label.trim(),
      type: input.type,
      baseUrl,
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
        try {
          existing.baseUrl = normalizeHttpBaseUrl(input.baseUrl)
        } catch {
          return badRequest(c, "invalid_base_url", "Invalid provider endpoint")
        }
      }
      if (input.label !== undefined) existing.label = input.label.trim()
      if (input.type !== undefined) existing.type = input.type
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
          ? `${provider.baseUrl}/v1/models`
          : `${provider.baseUrl}/models`
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
 * the text delta (if any), the refined usage accumulator, and whether this
 * payload is a terminal frame (`[DONE]` handled by the caller). */
function handleUpstreamEvent(
  api: UpstreamApi,
  raw: string,
  usage: TestUsage | undefined
): { usage: TestUsage | undefined; delta: string; stop?: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { usage, delta: "" }
  }
  if (!isRecord(parsed)) return { usage, delta: "" }
  const event = parsed

  if (api === "anthropic") {
    if (event.type === "content_block_delta") {
      const delta = optRecord(event.delta)
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { usage, delta: delta.text }
      }
    } else if (event.type === "message_stop") {
      return { usage, delta: "", stop: true }
    } else if (event.type === "message_start") {
      const u = optRecord(optRecord(event.message)?.usage)
      if (u) {
        usage = mergeUsage(usage, {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
        })
      }
    } else if (event.type === "message_delta") {
      const u = optRecord(event.usage)
      if (u) usage = mergeUsage(usage, { output: num(u.output_tokens) })
    }
    return { usage, delta: "" }
  }

  if (api === "openai") {
    const choices = Array.isArray(event.choices) ? event.choices : []
    const delta = optRecord(optRecord(choices[0])?.delta)
    const text =
      typeof delta?.content === "string" && delta.content ? delta.content : ""
    const u = optRecord(event.usage)
    if (u) {
      const details = optRecord(u.prompt_tokens_details)
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
    const u = optRecord(optRecord(event.response)?.usage)
    if (u) {
      const details = optRecord(u.input_tokens_details)
      usage = mergeUsage(usage, {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(details?.cached_tokens),
      })
    }
    return { usage, delta: "", stop: true }
  }
  return { usage, delta: "" }
}

/** Read an upstream SSE body (text/event-stream), invoking `onDelta` per
 * text chunk and returning the final token usage when the stream reports
 * one, plus whether a terminal frame was seen (OpenAI `[DONE]`, anthropic
 * `message_stop`, responses `response.completed`). Minimal framing: splits
 * events on blank lines, joins multi-line `data:` fields. */
async function pumpUpstreamSse(
  body: ReadableStream<Uint8Array>,
  api: UpstreamApi,
  onDelta: (text: string) => Promise<void> | void,
  onChunk?: () => void
): Promise<{ usage: TestUsage | undefined; terminated: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: TestUsage | undefined
  let terminated = false

  const drainBlock = async (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data) return
    if (data === "[DONE]") {
      terminated = true
      return
    }
    const result = handleUpstreamEvent(api, data, usage)
    usage = result.usage
    if (result.stop) terminated = true
    if (result.delta) await onDelta(result.delta)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk?.()
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
  return { usage, terminated }
}
