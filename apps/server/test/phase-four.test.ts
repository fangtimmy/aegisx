import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat"
import { AuthStorage } from "@earendil-works/pi-coding-agent"
import { createApp } from "../src/app"
import { summarizeUsage } from "../src/usage"

const roots: string[] = []
const closeApps: Array<() => void> = []
const providers: Array<{ unregister(): void }> = []

afterEach(() => {
  for (const close of closeApps.splice(0)) close()
  for (const provider of providers.splice(0)) provider.unregister()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "aegisx-phase-four-"))
  roots.push(dataDir)
  const faux = registerFauxProvider()
  providers.push(faux)
  const authStorage = AuthStorage.inMemory()
  authStorage.setRuntimeApiKey("faux", "test-only")
  const instance = createApp({
    dataDir,
    authStorage,
    resolveModel: (provider, modelId) =>
      provider === "faux" && modelId === faux.getModel().id
        ? (faux.getModel() as never)
        : undefined,
  })
  closeApps.push(instance.close)
  return { ...instance, dataDir, faux }
}

function json(method: "POST" | "PATCH", body: object) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function createChallenge(app: ReturnType<typeof createApp>["app"]) {
  const event = await (
    await app.request(
      "/api/events",
      json("POST", { name: "Phase 4", description: "Settings and stats" })
    )
  ).json()
  const challenge = await (
    await app.request(
      `/api/events/${event.id}/challenges`,
      json("POST", { name: "Accounting", description: "Count usage" })
    )
  ).json()
  return { event, challenge }
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean
) {
  const deadline = Date.now() + 8_000
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state")
    await Bun.sleep(25)
  }
}

const settings = {
  providerType: "builtin",
  provider: "faux",
  modelId: "faux-1",
  baseUrl: null,
  environment: "container",
  containerImage: "alpine:3.22",
  cpus: 0.5,
  memoryMb: 256,
  pidsLimit: 64,
  maxConcurrency: 3,
}

function sessionFile(usage: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}) {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: "/workspace",
  })}\n${JSON.stringify({
    type: "message",
    id: crypto.randomUUID().slice(0, 8),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
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
    },
  })}\n`
}

describe("phase four", () => {
  test("masks settings, inherits defaults, and exposes unavailable platform tools", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    const initial = await (await instance.app.request("/api/settings")).json()
    expect(initial).toMatchObject({
      providerType: "builtin",
      environment: "local",
      hasApiKey: false,
      apiKeyMask: null,
    })

    const saved = await instance.app.request(
      "/api/settings",
      json("PATCH", { ...settings, apiKey: "phase-four-secret" })
    )
    expect(saved.status).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody).toMatchObject({
      ...settings,
      hasApiKey: true,
      apiKeyMask: "****cret",
    })
    expect(JSON.stringify(savedBody)).not.toContain("phase-four-secret")

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
      provider: "faux",
      modelId: "faux-1",
      environment: "container",
      image: "alpine:3.22",
      cpus: 0.5,
      memoryMb: 256,
      pidsLimit: 64,
    })
    expect(JSON.stringify(detail.history)).toContain(
      "CTF platform integration is unavailable"
    )
    expect(JSON.stringify(detail)).not.toContain("flag{hidden}")
    expect(JSON.stringify(detail)).not.toContain("phase-four-secret")
    expect(
      await (await instance.app.request("/api/platform/status")).json()
    ).toEqual({ available: false })

    const sqlite = new Database(join(instance.dataDir, "aegisx.sqlite"))
    const stored = sqlite
      .query("select model_config, environment_config from runs where id = ?")
      .get(run.id) as Record<string, string>
    expect(JSON.parse(stored.model_config)).toEqual({
      provider: "faux",
      modelId: "faux-1",
    })
    expect(JSON.parse(stored.environment_config)).toEqual({
      type: "container",
      image: "alpine:3.22",
      cpus: 0.5,
      memoryMb: 256,
      pidsLimit: 64,
    })
    expect(
      sqlite.query("select api_key from settings where id = 1").get()
    ).toEqual({ api_key: "phase-four-secret" })
    sqlite.close()

    const preserved = await instance.app.request(
      "/api/settings",
      json("PATCH", settings)
    )
    expect((await preserved.json()).hasApiKey).toBe(true)
    const cleared = await instance.app.request(
      "/api/settings",
      json("PATCH", { ...settings, apiKey: null })
    )
    expect((await cleared.json()).hasApiKey).toBe(false)

    const invalid = await instance.app.request(
      "/api/settings",
      json("PATCH", {
        ...settings,
        providerType: "openai-compatible",
        baseUrl: "file:///tmp/model",
      })
    )
    expect(invalid.status).toBe(400)
  }, 30_000)

  test("aggregates fixed JSONL usage for runs, challenges, and events", async () => {
    expect(summarizeUsage([], false).cost).toBeNull()
    const instance = setup()
    const { event, challenge } = await createChallenge(instance.app)
    const sessionsDir = join(instance.dataDir, "sessions", "stats")
    mkdirSync(sessionsDir, { recursive: true })
    const firstPath = join(sessionsDir, "known.jsonl")
    const secondPath = join(sessionsDir, "unknown.jsonl")
    writeFileSync(
      firstPath,
      sessionFile({
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: 0.25,
      })
    )
    writeFileSync(
      secondPath,
      sessionFile({
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: 9,
      })
    )
    const sqlite = new Database(join(instance.dataDir, "aegisx.sqlite"))
    const now = new Date().toISOString()
    const insert = sqlite.prepare(
      "insert into runs (id, challenge_id, status, model_config, session_path, created_at, updated_at, completed_at) values (?, ?, 'completed', ?, ?, ?, ?, ?)"
    )
    insert.run(
      "known-cost",
      challenge.id,
      JSON.stringify({ provider: "faux", modelId: "faux-1" }),
      "sessions/stats/known.jsonl",
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
      "sessions/stats/unknown.jsonl",
      now,
      now,
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
