import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat"
import { AuthStorage } from "@earendil-works/pi-coding-agent"
import { createApp } from "../src/app"

const tempDirs: string[] = []
const closeApps: Array<() => void> = []
const fauxProviders: Array<{ unregister(): void }> = []
const configuredModels = new WeakMap<object, Promise<string>>()

afterEach(() => {
  for (const close of closeApps.splice(0)) close()
  for (const provider of fauxProviders.splice(0)) provider.unregister()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function setup(maxConcurrency = 2, dataDir?: string) {
  const root = dataDir ?? mkdtempSync(join(tmpdir(), "aegisx-phase-two-"))
  if (!dataDir) tempDirs.push(root)
  const faux = registerFauxProvider()
  fauxProviders.push(faux)
  const authStorage = AuthStorage.inMemory()
  authStorage.setRuntimeApiKey("faux", "test-only")
  const instance = createApp({
    dataDir: root,
    maxConcurrency,
    authStorage,
    resolveModel: (_provider, modelId) =>
      modelId === faux.getModel().id ? (faux.getModel() as never) : undefined,
  })
  closeApps.push(instance.close)
  return { ...instance, dataDir: root, faux }
}

function json(method: string, body: unknown) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function createChallenge(app: ReturnType<typeof createApp>["app"]) {
  const eventResponse = await app.request(
    "/api/events",
    json("POST", { name: "Phase 2" })
  )
  const event = await eventResponse.json()
  const challengeResponse = await app.request(
    `/api/events/${event.id}/challenges`,
    json("POST", {
      name: "Byte Copy",
      description: "Inspect the supplied bytes and finish the run.",
      category: "forensics",
      points: 200,
    })
  )
  return { event, challenge: await challengeResponse.json() }
}

async function createRun(
  app: ReturnType<typeof createApp>["app"],
  challengeId: string
) {
  const modelId = await configureFaux(app)
  return app.request(
    `/api/challenges/${challengeId}/runs`,
    json("POST", { modelId })
  )
}

function configureFaux(app: ReturnType<typeof createApp>["app"]) {
  const cached = configuredModels.get(app)
  if (cached) return cached
  const configured = (async () => {
    const providers = await (await app.request("/api/providers")).json()
    const provider = providers.items[0]
    await app.request(
      `/api/providers/${provider.id}`,
      json("PATCH", {
        label: "Faux",
        type: "openai-compatible",
        baseUrl: "http://localhost:4010/v1",
        apiKey: "test-only",
        enabled: true,
      })
    )
    const model = await (
      await app.request(
        `/api/providers/${provider.id}/models`,
        json("POST", { modelId: "faux-1", label: "Faux 1" })
      )
    ).json()
    return model.id as string
  })()
  configuredModels.set(app, configured)
  return configured
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean
) {
  const deadline = Date.now() + 3_000
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state")
    await Bun.sleep(20)
  }
}

describe("phase two run API", () => {
  test("isolates files, copies attachments, completes, and reloads JSONL", async () => {
    const first = setup()
    const { event, challenge } = await createChallenge(first.app)
    const bytes = new Uint8Array([0, 255, 80, 75, 3, 4, 10])
    const uploaded = await first.app.request(
      `/api/challenges/${challenge.id}/attachments?filename=evidence.bin`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }
    )
    expect(uploaded.status).toBe(201)

    first.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("finish_run", {
          summary: "Verified the evidence",
          flag: "flag{phase_two}",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("finish_run", { summary: "Second workspace" }),
        { stopReason: "toolUse" }
      ),
    ])
    const firstResponse = await createRun(first.app, challenge.id)
    const secondResponse = await createRun(first.app, challenge.id)
    expect(firstResponse.status).toBe(202)
    expect(secondResponse.status).toBe(202)
    const firstRun = await firstResponse.json()
    await secondResponse.json()

    const detail = await waitFor(
      async () =>
        (
          await first.app.request(`/api/runs/${firstRun.id}`)
        ).json() as Promise<{
          run: { status: string; flag?: string; summary: string | null }
          history: unknown[]
        }>,
      (value) => value.run.status === "completed"
    )
    expect(detail.run).toMatchObject({
      summary: "Verified the evidence",
      flag: "flag{phase_two}",
    })
    await waitFor(
      async () => first.activeSessionCount(),
      (count) => count === 0
    )
    expect(JSON.stringify(detail.history)).not.toContain("flag{phase_two}")

    const sqlite = new Database(join(first.dataDir, "aegisx.sqlite"))
    const stored = sqlite
      .query(
        "select id, prompt, model_config, environment_config, workspace_path, session_path from runs order by created_at"
      )
      .all() as Array<Record<string, string>>
    sqlite.close()
    expect(stored).toHaveLength(2)
    expect(stored[0].workspace_path).not.toBe(stored[1].workspace_path)
    expect(stored[0].session_path).not.toBe(stored[1].session_path)
    expect(isAbsolute(stored[0].workspace_path)).toBe(false)
    expect(isAbsolute(stored[0].session_path)).toBe(false)
    expect(stored[0].prompt).toContain("evidence.bin")
    expect(JSON.parse(stored[0].model_config)).toMatchObject({
      providerLabel: "Faux",
      modelId: "faux-1",
      costKnown: false,
    })
    expect(JSON.parse(stored[0].environment_config)).toEqual({ type: "local" })

    for (const run of stored) {
      const copied = join(first.dataDir, run.workspace_path, "evidence.bin")
      expect(
        createHash("sha256").update(readFileSync(copied)).digest("hex")
      ).toBe(createHash("sha256").update(bytes).digest("hex"))
      expect(existsSync(join(first.dataDir, run.session_path))).toBe(true)
    }

    const listed = await (
      await first.app.request(`/api/events/${event.id}/runs`)
    ).json()
    expect(listed.items[0].flag).toBeUndefined()
    expect(JSON.stringify(listed)).not.toContain(first.dataDir)

    first.close()
    closeApps.pop()
    const reopened = setup(2, first.dataDir)
    const reopenedDetail = await (
      await reopened.app.request(`/api/runs/${firstRun.id}`)
    ).json()
    expect(reopenedDetail.history.length).toBeGreaterThan(0)
    expect(JSON.stringify(reopenedDetail)).not.toContain(first.dataDir)
  })

  test("rejects capacity and enforces pause, resume, message, and stop", async () => {
    const instance = setup(1)
    const { challenge } = await createChallenge(instance.app)
    instance.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "printf started > started; sleep 30",
        }),
        { stopReason: "toolUse" }
      ),
    ])
    const created = await createRun(instance.app, challenge.id)
    const run = await created.json()
    await waitFor(
      async () =>
        existsSync(join(instance.dataDir, "workspaces", run.id, "started")),
      Boolean
    )

    const rejected = await createRun(instance.app, challenge.id)
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: { code: "capacity" } })

    const paused = await instance.app.request(
      `/api/runs/${run.id}/pause`,
      json("POST", {})
    )
    expect((await paused.json()).status).toBe("paused")

    instance.faux.setResponses([fauxAssistantMessage("Resumed and idle.")])
    const resumed = await instance.app.request(
      `/api/runs/${run.id}/resume`,
      json("POST", { message: "Resume from the interruption." })
    )
    expect((await resumed.json()).status).toBe("running")
    await waitFor(async () => {
      const detail = await (
        await instance.app.request(`/api/runs/${run.id}`)
      ).json()
      return detail.history.some(
        (entry: { type: string; message?: { role: string } }) =>
          entry.type === "message" && entry.message?.role === "assistant"
      )
    }, Boolean)

    instance.faux.setResponses([fauxAssistantMessage("Acknowledged.")])
    const messaged = await instance.app.request(
      `/api/runs/${run.id}/message`,
      json("POST", { message: "Check the result once more." })
    )
    expect((await messaged.json()).status).toBe("running")

    const stopped = await instance.app.request(
      `/api/runs/${run.id}/stop`,
      json("POST", {})
    )
    expect((await stopped.json()).status).toBe("stopped")
    expect(instance.activeSessionCount()).toBe(0)
    expect(
      (
        await instance.app.request(
          `/api/runs/${run.id}/resume`,
          json("POST", {})
        )
      ).status
    ).toBe(409)
  })

  test("changes persisted running runs to paused on startup", async () => {
    const first = setup()
    const { challenge } = await createChallenge(first.app)
    first.close()
    closeApps.pop()
    const sqlite = new Database(join(first.dataDir, "aegisx.sqlite"))
    const now = new Date().toISOString()
    sqlite.run(
      "insert into runs (id, challenge_id, status, created_at, updated_at) values (?, ?, 'running', ?, ?)",
      ["interrupted", challenge.id, now, now]
    )
    sqlite.close()

    const second = setup(2, first.dataDir)
    const detail = await second.app.request("/api/runs/interrupted")
    expect(detail.status).toBe(200)
    expect((await detail.json()).run.status).toBe("paused")
  })
})
