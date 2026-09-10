import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import { parseJson, responseJson } from "../src/lib/guards"
import { normalizeModelMetadata } from "../src/providers/builtin-models"
import { generateModelsJson } from "../src/providers/models-json"
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
  const path = mkdtempSync(join(tmpdir(), "aegisx-relay-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

const GATEWAY_URL = "https://llm-gateway.example.com/proxy/e/tok"

async function createGatewayProvider(app: ReturnType<typeof createTestApp>) {
  const created = await app.request(
    "/api/providers",
    json("POST", {
      label: "DASCTF gateway",
      type: "openai-responses",
      baseUrl: GATEWAY_URL,
      exactEndpoint: true,
      apiKey: "gateway-key",
      enabled: true,
    })
  )
  expect(created.status).toBe(201)
  const body = await responseJson<{ id: string; exactEndpoint: boolean }>(
    created
  )
  expect(body.exactEndpoint).toBe(true)
  return body.id
}

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

describe("exact-endpoint gateway relay", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("POST /api/llm-relay/:id/* forwards verbatim to the gateway URL and streams the response back", async () => {
    const app = createTestApp()
    const id = await createGatewayProvider(app)
    const calls: Array<{ url: string; init: RequestInit }> = []
    installFetchMock(async (input, init) => {
      calls.push({ url: requestUrl(input), init: init! })
      return new Response('{"upstream":true}', {
        status: 201,
        headers: { "content-type": "application/json", "x-gw": "yes" },
      })
    })
    // The SDK's Bearer is the provider's gateway key — not an agent token —
    // so this also proves the relay sits outside the agent-auth gate.
    const response = await app.request(`/api/llm-relay/${id}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer gateway-key",
      },
      body: JSON.stringify({ model: "deepseek-r1", stream: true, input: "hi" }),
    })
    expect(response.status).toBe(201)
    expect(response.headers.get("x-gw")).toBe("yes")
    expect(await response.text()).toBe('{"upstream":true}')
    expect(calls).toHaveLength(1)
    // The appended /responses suffix is swallowed: the gateway URL is hit
    // exactly.
    expect(calls[0].url).toBe(GATEWAY_URL)
    expect(calls[0].init.method).toBe("POST")
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("authorization")).toBe("Bearer gateway-key")
    expect(
      parseJson<Record<string, unknown>>(
        new TextDecoder().decode(refine<ArrayBuffer>(calls[0].init.body))
      )
    ).toEqual({ model: "deepseek-r1", stream: true, input: "hi" })
  })

  test("relay rejects unknown and non-exact-endpoint providers", async () => {
    const app = createTestApp()
    const missing = await app.request("/api/llm-relay/nope/responses", {
      method: "POST",
    })
    expect(missing.status).toBe(404)
    const created = await app.request(
      "/api/providers",
      json("POST", {
        label: "Plain",
        type: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        enabled: true,
      })
    )
    const { id } = await responseJson<{ id: string }>(created)
    const plain = await app.request(`/api/llm-relay/${id}/chat/completions`, {
      method: "POST",
    })
    expect(plain.status).toBe(404)
  })

  test("test dialogue on an exact-endpoint provider hits the gateway URL verbatim", async () => {
    const app = createTestApp()
    const id = await createGatewayProvider(app)
    const calls: Array<{ url: string }> = []
    installFetchMock(async (input) => {
      calls.push({ url: requestUrl(input) })
      return new Response(
        "data: " +
          JSON.stringify({
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          }) +
          "\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }
      )
    })
    const response = await app.request(
      `/api/providers/${id}/test`,
      json("POST", { modelId: "deepseek-r1", prompt: "hi" })
    )
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe(GATEWAY_URL)
  })

  test("models.json routes exact-endpoint providers through /api/llm-relay", () => {
    const model = {
      id: "m1",
      providerId: "",
      modelId: "deepseek-r1",
      label: "R1",
      enabled: true,
      metadata: normalizeModelMetadata({}),
      metadataSource: null,
      thinkingLevels: [],
    }
    const modelsJson = generateModelsJson(
      [
        {
          id: "gw-1",
          label: "Gateway",
          type: "openai-responses",
          baseUrl: GATEWAY_URL,
          exactEndpoint: true,
          apiKey: "k",
          enabled: true,
          models: [{ ...model, providerId: "gw-1" }],
        },
        {
          id: "plain-1",
          label: "Plain",
          type: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          exactEndpoint: false,
          apiKey: "k",
          enabled: true,
          models: [{ ...model, providerId: "plain-1" }],
        },
      ],
      "http://127.0.0.1:3000"
    )
    expect(modelsJson.providers["aegisx-gw-1"]?.baseUrl).toBe(
      "http://127.0.0.1:3000/api/llm-relay/gw-1"
    )
    expect(modelsJson.providers["aegisx-plain-1"]?.baseUrl).toBe(
      "https://api.example.com/v1"
    )
  })
})
