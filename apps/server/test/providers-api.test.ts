import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import { parseJson, responseJson } from "../src/lib/guards"
import { refine } from "./support"
import { json } from "./support"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-providers-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

const providerBody = {
  label: "Test",
  type: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "real-key",
  enabled: true,
}

describe("provider API (model-runtime hygiene)", () => {
  test("POST /api/providers rejects $ENV-style apiKeys (models.json must carry a literal key)", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/providers",
      json("POST", { ...providerBody, apiKey: "$OPENAI_KEY" })
    )
    expect(response.status).toBe(400)
    const body = await responseJson<{ error: { message: string } }>(response)
    expect(body.error.message).toContain("literal")
  })

  test("PATCH /api/providers/:id rejects $ENV-style apiKeys", async () => {
    const app = createTestApp()
    const created = await app.request(
      "/api/providers",
      json("POST", providerBody)
    )
    expect(created.status).toBe(201)
    const { id } = await responseJson<{ id: string }>(created)
    const patched = await app.request(
      `/api/providers/${id}`,
      json("PATCH", { apiKey: "$BAD" })
    )
    expect(patched.status).toBe(400)
  })

  test("POST /api/providers accepts a literal apiKey", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/providers",
      json("POST", providerBody)
    )
    expect(response.status).toBe(201)
  })
})

describe("pi builtin catalog endpoint", () => {
  test("GET /api/providers/:id/models/builtins carries metadata for selection-time preview", async () => {
    const app = createTestApp()
    const created = await app.request(
      "/api/providers",
      json("POST", providerBody)
    )
    expect(created.status).toBe(201)
    const { id } = await responseJson<{ id: string }>(created)
    const response = await app.request(`/api/providers/${id}/models/builtins`)
    expect(response.status).toBe(200)
    const body = await responseJson<{
      items: Array<{
        providerId: string
        modelId: string
        name: string
        metadata: {
          contextWindow: number
          maxTokens: number
          reasoning: boolean
          costKnown: boolean
          input: string[]
        }
      }>
    }>(response)
    expect(body.items.length).toBeGreaterThan(100)
    for (const item of body.items) {
      expect(item.metadata.contextWindow).toBeGreaterThan(0)
      expect(item.metadata.maxTokens).toBeGreaterThan(0)
      expect(typeof item.metadata.reasoning).toBe("boolean")
      expect(item.metadata.input.length).toBeGreaterThan(0)
    }
    expect(body.items.some((item) => item.metadata.costKnown)).toBe(true)
  })
})

/** Install a fetch mock (Bun's typeof fetch also carries `preconnect`, so
 * plain functions need the widening cast — routed through refine). */
function installFetchMock(
  impl: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Response | Promise<Response>
) {
  globalThis.fetch = refine<typeof fetch>(impl)
}

/** URL string of a fetch input (URL / string / Request). */
function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href
  return typeof input === "string" ? input : input.url
}

/** An upstream SSE Response built from raw frames. */
function upstreamSse(frames: string[]) {
  const body = [
    ...frames.map((frame) => `data: ${frame}\n\n`),
    "data: [DONE]\n\n",
  ].join("")
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/** Parse the proxied client SSE stream into event objects. */
async function readSseEvents(response: Response) {
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const text = await response.text()
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) =>
      parseJson<Record<string, unknown>>(
        block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
      )
    )
}

describe("provider test dialogue (POST /api/providers/:id/test)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  async function createTestProvider(
    type: "openai-compatible" | "openai-responses" | "anthropic-messages",
    baseUrl = providerBody.baseUrl
  ) {
    const app = createTestApp()
    const created = await app.request(
      "/api/providers",
      json("POST", { ...providerBody, type, baseUrl })
    )
    expect(created.status).toBe(201)
    const { id } = await responseJson<{ id: string }>(created)
    return { app, id }
  }

  test("openai-compatible streams /chat/completions with usage", async () => {
    const { app, id } = await createTestProvider("openai-compatible")
    const calls: Array<{ url: string; init: RequestInit }> = []
    installFetchMock(async (input, init) => {
      calls.push({ url: requestUrl(input), init: init! })
      return upstreamSse([
        '{"choices":[{"delta":{"content":"Hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
      ])
    })
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "gpt-4o", prompt: "hi" })
    )
    expect(response.status).toBe(200)
    const events = await readSseEvents(response)
    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      {
        type: "done",
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions")
    expect(calls[0].init.method).toBe("POST")
    const headers = refine<Record<string, string>>(calls[0].init.headers)
    expect(headers.Authorization).toBe("Bearer real-key")
    expect(headers["content-type"]).toBe("application/json")
    expect(
      parseJson<Record<string, unknown>>(refine<string>(calls[0].init.body))
    ).toEqual({
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    })
  })

  test("openai-responses streams /v1/responses", async () => {
    const { app, id } = await createTestProvider("openai-responses")
    const calls: Array<{ url: string; init: RequestInit }> = []
    installFetchMock(async (input, init) => {
      calls.push({ url: requestUrl(input), init: init! })
      return upstreamSse([
        '{"type":"response.output_text.delta","delta":"Hey"}',
        '{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}',
      ])
    })
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "gpt-5", prompt: "hi" })
    )
    expect(response.status).toBe(200)
    const events = await readSseEvents(response)
    expect(events).toEqual([
      { type: "delta", text: "Hey" },
      {
        type: "done",
        usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    expect(calls[0].url).toBe("https://api.example.com/v1/responses")
    expect(
      parseJson<Record<string, unknown>>(refine<string>(calls[0].init.body))
    ).toEqual({
      model: "gpt-5",
      stream: true,
      input: "hi",
    })
  })

  test("anthropic-messages posts to /v1/messages with x-api-key headers", async () => {
    const { app, id } = await createTestProvider(
      "anthropic-messages",
      "https://api.anthropic.com"
    )
    const calls: Array<{ url: string; init: RequestInit }> = []
    installFetchMock(async (input, init) => {
      calls.push({ url: requestUrl(input), init: init! })
      return upstreamSse([
        '{"type":"message_start","message":{"usage":{"input_tokens":3}}}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        '{"type":"message_delta","usage":{"output_tokens":2}}',
        '{"type":"message_stop"}',
      ])
    })
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "claude-sonnet-4-5", prompt: "hi" })
    )
    expect(response.status).toBe(200)
    const events = await readSseEvents(response)
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      {
        type: "done",
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages")
    const headers = refine<Record<string, string>>(calls[0].init.headers)
    expect(headers.Authorization).toBeUndefined()
    expect(headers["x-api-key"]).toBe("real-key")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(
      parseJson<Record<string, unknown>>(refine<string>(calls[0].init.body))
    ).toEqual({
      model: "claude-sonnet-4-5",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    })
  })

  test("upstream failure surfaces 502 provider_unavailable with the upstream body", async () => {
    const { app, id } = await createTestProvider("openai-compatible")
    installFetchMock(
      async () =>
        new Response('{"error":{"message":"Incorrect API key"}}', {
          status: 401,
        })
    )
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "gpt-4o", prompt: "hi" })
    )
    expect(response.status).toBe(502)
    const body = await responseJson<{
      error: { code: string; message: string }
    }>(response)
    expect(body.error.code).toBe("provider_unavailable")
    expect(body.error.message).toContain("401")
    expect(body.error.message).toContain("Incorrect API key")
  })

  test("timeout aborts to 502", async () => {
    const { app, id } = await createTestProvider("openai-compatible")
    const patched = await app.request(
      "/api/settings",
      json("PATCH", { "runtime.providerDiscoverTimeoutMs": 1000 })
    )
    expect(patched.status).toBe(200)
    installFetchMock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          )
        })
    )
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "gpt-4o", prompt: "hi" })
    )
    expect(response.status).toBe(502)
    const body = await responseJson<{
      error: { code: string; message: string }
    }>(response)
    expect(body.error.code).toBe("provider_unavailable")
    expect(body.error.message).toContain("timeout")
  })

  test("unknown provider or model-less body rejects", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/providers/missing/test",
      json("POST", { modelId: "gpt-4o", prompt: "hi" })
    )
    expect(response.status).toBe(404)
    const missingPrompt = await app.request(
      "/api/providers/missing/test",
      json("POST", { modelId: "gpt-4o" })
    )
    expect(missingPrompt.status).toBe(400)
  })
})
