import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { createApp } from "../src/app"
import { summarizeUsage } from "../src/usage"
import { json, waitFor } from "./support"

const roots: string[] = []
const closeApps: Array<() => void> = []

afterEach(() => {
  for (const close of closeApps.splice(0)) close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "aegisx-providers-"))
  roots.push(dataDir)
  const faux = fauxProvider({ models: [{ id: "faux-1" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const instance = createApp({
    dataDir,
    models,
    resolveModel: (_provider, modelId) =>
      modelId === faux.getModel().id ? (faux.getModel() as never) : undefined,
  })
  closeApps.push(instance.close)
  return { ...instance, dataDir, faux }
}

async function createChallenge(app: ReturnType<typeof createApp>["app"]) {
  const event = await (
    await app.request("/api/events", json("POST", { name: "Provider tests" }))
  ).json()
  const challenge = await (
    await app.request(
      `/api/events/${event.id}/challenges`,
      json("POST", { name: "Accounting", description: "Count usage" })
    )
  ).json()
  return { event, challenge }
}

const runtimeSettings = {
  environment: "container",
  containerImage: "alpine:3.22",
  cpus: 0.5,
  memoryMb: 256,
  pidsLimit: 64,
  maxConcurrency: 3,
}

function usageMessage(usage: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "usage" }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      ...usage,
      cost: {
        input: usage.cost,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: usage.cost,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

describe("providers, models, and usage", () => {
  test("discovers models through the configured provider endpoint", async () => {
    const instance = setup()
    let authorization = ""
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? ""
        return Response.json({ data: [{ id: "faux-1" }, { id: "faux-2" }] })
      },
    })
    try {
      const provider = await (
        await instance.app.request(
          "/api/providers",
          json("POST", {
            label: "Model API",
            type: "openai-compatible",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            apiKey: "discover-secret",
            enabled: true,
          })
        )
      ).json()
      const discovered = await (
        await instance.app.request(
          `/api/providers/${provider.id}/models/discover`,
          { method: "POST" }
        )
      ).json()
      expect(discovered).toEqual({ models: ["faux-1", "faux-2"] })
      expect(authorization).toBe("Bearer discover-secret")
    } finally {
      server.stop(true)
    }
  })

  test("runs an OpenAI-compatible model without a Pi override", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegisx-openai-compatible-"))
    roots.push(dataDir)
    let authorization = ""
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? ""
        return new Response(
          [
            `data: ${JSON.stringify({
              id: "chatcmpl-1",
              object: "chat.completion.chunk",
              created: 0,
              model: "local-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "finish_run",
                          arguments: '{"summary":"OpenAI-compatible runtime"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "chatcmpl-1",
              object: "chat.completion.chunk",
              created: 0,
              model: "local-model",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } }
        )
      },
    })
    const instance = createApp({ dataDir })
    closeApps.push(instance.close)
    try {
      const provider = await (
        await instance.app.request(
          "/api/providers",
          json("POST", {
            label: "Local OpenAI",
            type: "openai-compatible",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            apiKey: "runtime-secret",
            enabled: true,
          })
        )
      ).json()
      const model = await (
        await instance.app.request(
          `/api/providers/${provider.id}/models`,
          json("POST", { modelId: "local-model", label: "Local model" })
        )
      ).json()
      const { challenge } = await createChallenge(instance.app)
      const run = await (
        await instance.app.request(
          `/api/challenges/${challenge.id}/runs`,
          json("POST", { modelId: model.id })
        )
      ).json()
      const detail = await waitFor(
        async () =>
          (
            await instance.app.request(`/api/runs/${run.id}`)
          ).json() as Promise<{
            run: { status: string; summary: string | null }
          }>,
        (value) => value.run.status === "completed"
      )
      expect(detail.run.summary).toBe("OpenAI-compatible runtime")
      expect(authorization).toBe("Bearer runtime-secret")
    } finally {
      server.stop(true)
    }
  })

  test("redacts provider errors before message persistence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegisx-provider-error-"))
    roots.push(dataDir)
    let providerId = ""
    let authorization = ""
    let instance: ReturnType<typeof createApp> | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization") ?? ""
        if (instance && providerId) {
          await instance.app.request(
            `/api/providers/${providerId}`,
            json("PATCH", { apiKey: "intermediate-secret" })
          )
          await instance.app.request(
            `/api/providers/${providerId}`,
            json("PATCH", { apiKey: "rotated-secret" })
          )
        }
        return Response.json(
          { error: { message: "Rejected intermediate-secret" } },
          { status: 401 }
        )
      },
    })
    instance = createApp({ dataDir })
    closeApps.push(instance.close)
    try {
      const provider = await (
        await instance.app.request(
          "/api/providers",
          json("POST", {
            label: "Failure provider",
            type: "openai-compatible",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            apiKey: "initial-secret",
            enabled: true,
          })
        )
      ).json()
      providerId = provider.id
      const model = await (
        await instance.app.request(
          `/api/providers/${provider.id}/models`,
          json("POST", { modelId: "failure-model", label: "Failure model" })
        )
      ).json()
      const { challenge } = await createChallenge(instance.app)
      const run = await (
        await instance.app.request(
          `/api/challenges/${challenge.id}/runs`,
          json("POST", { modelId: model.id })
        )
      ).json()
      const detail = await waitFor(
        async () =>
          (
            await instance.app.request(`/api/runs/${run.id}`)
          ).json() as Promise<{
            history: unknown[]
          }>,
        (value) => JSON.stringify(value.history).includes("[redacted]")
      )
      const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
      const messages = sqlite
        .query(
          "select message from agent_messages where agent_id = ? order by sequence"
        )
        .all(run.id) as Array<{ message: string }>
      sqlite.close()
      expect(authorization).toBe("Bearer initial-secret")
      expect(JSON.stringify(detail)).not.toContain("initial-secret")
      expect(JSON.stringify(detail)).not.toContain("intermediate-secret")
      expect(JSON.stringify(detail)).not.toContain("rotated-secret")
      expect(JSON.stringify(messages)).not.toContain("initial-secret")
      expect(JSON.stringify(messages)).not.toContain("intermediate-secret")
      expect(JSON.stringify(messages)).not.toContain("rotated-secret")
    } finally {
      server.stop(true)
    }
  })

  test("manages provider models, inherits defaults, and rejects unavailable platform tools", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    const initial = await (await instance.app.request("/api/settings")).json()
    expect(initial).toMatchObject({
      environment: "local",
      defaultModelId: "default-model",
    })

    const providerResponse = await instance.app.request(
      "/api/providers",
      json("POST", {
        label: "Faux",
        type: "openai-compatible",
        baseUrl: "http://localhost:4012/v1",
        apiKey: "provider-test-secret",
        enabled: true,
      })
    )
    expect(providerResponse.status).toBe(201)
    const provider = await providerResponse.json()
    expect(provider.apiKey).toBe("provider-test-secret")
    const modelResponse = await instance.app.request(
      `/api/providers/${provider.id}/models`,
      json("POST", { modelId: "faux-1", label: "Faux 1" })
    )
    expect(modelResponse.status).toBe(201)
    const model = await modelResponse.json()
    const saved = await instance.app.request(
      "/api/settings",
      json("PATCH", { ...runtimeSettings, defaultModelId: model.id })
    )
    expect(saved.status).toBe(200)
    expect((await saved.json()).defaultModelId).toBe(model.id)
    const providers = await (
      await instance.app.request("/api/providers")
    ).json()
    expect(
      providers.items.find((item: { id: string }) => item.id === provider.id)
    ).toMatchObject({
      apiKey: "provider-test-secret",
      models: [{ id: model.id, modelId: "faux-1" }],
    })

    instance.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("start_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("stop_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("submit_flag", { flag: "flag{hidden}" }),
        {
          stopReason: "toolUse",
        }
      ),
      fauxAssistantMessage(
        fauxToolCall("finish_run", {
          summary: "Platform unavailable verified",
        }),
        { stopReason: "toolUse" }
      ),
    ])
    const run = await (
      await instance.app.request(
        `/api/challenges/${challenge.id}/runs`,
        json("POST", {})
      )
    ).json()
    const detail = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          run: Record<string, unknown> & { status: string }
          history: unknown[]
        }>,
      (value) => value.run.status === "completed"
    )
    expect(detail.run).toMatchObject({
      provider: "Faux",
      modelId: "faux-1",
      environment: "container",
      image: "alpine:3.22",
      cpus: 0.5,
      memoryMb: 256,
      pidsLimit: 64,
    })
    expect(JSON.stringify(detail.history)).toContain(
      "Tool start_target not found"
    )
    expect(JSON.stringify(detail)).not.toContain("flag{hidden}")
    expect(JSON.stringify(detail)).not.toContain("provider-test-secret")
    expect(
      await (await instance.app.request("/api/platform/status")).json()
    ).toEqual({ available: false })

    const sqlite = new Database(join(instance.dataDir, "aegisx.sqlite"))
    const stored = sqlite
      .query("select model_config, environment_config from runs where id = ?")
      .get(run.id) as Record<string, string>
    expect(JSON.parse(stored.model_config)).toEqual({
      provider: `aegisx-${provider.id}`,
      providerLabel: "Faux",
      modelId: "faux-1",
      costKnown: false,
    })
    expect(JSON.parse(stored.environment_config)).toEqual({
      type: "container",
      image: "alpine:3.22",
      cpus: 0.5,
      memoryMb: 256,
      pidsLimit: 64,
    })
    expect(
      sqlite
        .query("select api_key from provider_connections where id = ?")
        .get(provider.id)
    ).toEqual({ api_key: "provider-test-secret" })
    sqlite.close()

    const invalid = await instance.app.request(
      "/api/providers",
      json("POST", {
        label: "Invalid",
        type: "openai-compatible",
        baseUrl: "file:///tmp/model",
        apiKey: "test",
        enabled: true,
      })
    )
    expect(invalid.status).toBe(400)
    expect(
      (
        await instance.app.request(`/api/provider-models/${model.id}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(204)
    expect(
      (await (await instance.app.request("/api/settings")).json())
        .defaultModelId
    ).toBeNull()
  }, 30_000)

  test("aggregates persisted usage for runs, challenges, and events", async () => {
    expect(summarizeUsage([], false).cost).toBeNull()
    const instance = setup()
    const { event, challenge } = await createChallenge(instance.app)
    const sqlite = new Database(join(instance.dataDir, "aegisx.sqlite"))
    const now = new Date().toISOString()
    const insert = sqlite.prepare(
      "insert into runs (id, challenge_id, status, model_config, created_at, updated_at, completed_at) values (?, ?, 'completed', ?, ?, ?, ?)"
    )
    insert.run(
      "known-cost",
      challenge.id,
      JSON.stringify({ provider: "faux", modelId: "faux-1" }),
      now,
      now,
      now
    )
    insert.run(
      "unknown-cost",
      challenge.id,
      JSON.stringify({
        provider: "custom",
        modelId: "custom-1",
        costKnown: false,
      }),
      now,
      now,
      now
    )
    const insertAgent = sqlite.prepare(
      "insert into run_agents (id, run_id, name, status, created_at, updated_at, completed_at) values (?, ?, 'Main agent', 'completed', ?, ?, ?)"
    )
    insertAgent.run("known-cost", "known-cost", now, now, now)
    insertAgent.run("unknown-cost", "unknown-cost", now, now, now)
    const insertMessage = sqlite.prepare(
      "insert into agent_messages (id, agent_id, sequence, message, created_at) values (?, ?, 1, ?, ?)"
    )
    insertMessage.run(
      crypto.randomUUID(),
      "known-cost",
      JSON.stringify(
        usageMessage({
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: 0.25,
        })
      ),
      now
    )
    insertMessage.run(
      crypto.randomUUID(),
      "unknown-cost",
      JSON.stringify(
        usageMessage({
          input: 4,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 6,
          cost: 9,
        })
      ),
      now
    )
    sqlite.close()

    const runStats = await (
      await instance.app.request("/api/runs/known-cost/stats")
    ).json()
    expect(runStats.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: 0.25,
    })
    const unknown = await (
      await instance.app.request("/api/runs/unknown-cost/stats")
    ).json()
    expect(unknown.usage.cost).toBeNull()

    const challengeStats = await (
      await instance.app.request(`/api/challenges/${challenge.id}/stats`)
    ).json()
    expect(challengeStats).toMatchObject({
      runCount: 2,
      usage: {
        input: 14,
        output: 7,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 24,
        cost: null,
      },
    })
    const eventStats = await (
      await instance.app.request(`/api/events/${event.id}/stats`)
    ).json()
    expect(eventStats.runCount).toBe(2)
    expect(eventStats.usage).toEqual(challengeStats.usage)
    expect(eventStats.challenges[0]).toMatchObject({
      challengeId: challenge.id,
      runCount: 2,
      usage: { totalTokens: 24, cost: null },
    })
    expect(JSON.stringify(eventStats)).not.toContain(instance.dataDir)
  })
})
