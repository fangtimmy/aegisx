import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
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
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("literal")
  })

  test("PATCH /api/providers/:id rejects $ENV-style apiKeys", async () => {
    const app = createTestApp()
    const created = await app.request(
      "/api/providers",
      json("POST", providerBody)
    )
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
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

describe("provider test dialogue (POST /api/providers/:id/test)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Install a fetch mock (Bun's typeof fetch also carries `preconnect`, so
   * plain functions need the widening cast). */
  function installFetchMock(
    impl: (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Response | Promise<Response>
  ) {
    globalThis.fetch = impl as unknown as typeof fetch
  }

  async function createTestProvider(
    type: "openai-compatible" | "anthropic-messages",
    baseUrl = providerBody.baseUrl
  ) {
    const app = createTestApp()
    const created = await app.request(
      "/api/providers",
      json("POST", { ...providerBody, type, baseUrl })
    )
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    return { app, id }
  }

  test("openai-compatible posts a max_tokens=1 ping to /chat/completions", async () => {
    const { app, id } = await createTestProvider("openai-compatible")
    const calls: Array<{ url: string; init: RequestInit }> = []
    installFetchMock(async (input, init) => {
      calls.push({ url: String(input), init: init! })
      return new Response(JSON.stringify({ id: "cmpl-1" }), { status: 200 })
    })
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "gpt-4o" })
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; latencyMs: number }
    expect(body.ok).toBe(true)
    expect(typeof body.latencyMs).toBe("number")
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions")
    expect(calls[0]!.init.method).toBe("POST")
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer real-key")
    expect(headers["content-type"]).toBe("application/json")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    })
  })

  test("anthropic-messages posts to /v1/messages with x-api-key headers", async () => {
    const { app, id } = await createTestProvider(
      "anthropic-messages",
      "https://api.anthropic.com"
    )
    const calls: Array<{ url: string; init: RequestInit }> = []
    installFetchMock(async (input, init) => {
      calls.push({ url: String(input), init: init! })
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    })
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "claude-sonnet-4-5" })
    )
    expect(response.status).toBe(200)
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages")
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers["x-api-key"]).toBe("real-key")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
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
      json("POST", { modelId: "gpt-4o" })
    )
    expect(response.status).toBe(502)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }
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
      json("POST", { modelId: "gpt-4o" })
    )
    expect(response.status).toBe(502)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe("provider_unavailable")
    expect(body.error.message).toBe("Provider test failed")
  })

  test("unknown provider or model-less body rejects", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/providers/missing/test",
      json("POST", { modelId: "gpt-4o" })
    )
    expect(response.status).toBe(404)
  })
})
