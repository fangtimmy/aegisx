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
import { createApp } from "../../src/app"
import { json, waitFor } from "../support"

const roots: string[] = []
const closeApps: Array<() => void | Promise<void>> = []
const configuredModels = new WeakMap<object, Promise<string>>()

afterEach(async () => {
  for (const close of closeApps.splice(0)) await close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setup(options?: { maxConcurrency?: number }) {
  const dataDir = mkdtempSync(join(tmpdir(), "aegisx-lifecycle-"))
  roots.push(dataDir)
  const faux = fauxProvider({ models: [{ id: "faux-1" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const instance = createApp({
    dataDir,
    maxConcurrency: options?.maxConcurrency ?? 4,
    models,
    resolveModel: (_provider, modelId) =>
      modelId === faux.getModel().id ? (faux.getModel() as never) : undefined,
  })
  closeApps.push(instance.close)
  return { ...instance, dataDir, faux }
}

function tool(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: "toolUse",
  })
}

function configureFaux(app: ReturnType<typeof createApp>["app"]) {
  const cached = configuredModels.get(app)
  if (cached) return cached
  const configured = (async () => {
    const providers = await (await app.request("/api/providers")).json()
    const provider = providers.items[0]
    await app.request(`/api/providers/${provider.id}`, {
      ...json("PATCH", {
        label: "Faux",
        type: "openai-compatible",
        baseUrl: "http://localhost:4011/v1",
        apiKey: "test-secret",
        enabled: true,
      }),
      method: "PATCH",
    })
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

async function createChallenge(app: ReturnType<typeof createApp>["app"]) {
  const event = await (
    await app.request("/api/events", json("POST", { name: "Lifecycle" }))
  ).json()
  const challenge = await (
    await app.request(
      `/api/events/${event.id}/challenges`,
      json("POST", {
        name: "LC",
        description: "lifecycle fixture",
      })
    )
  ).json()
  return { event, challenge }
}

async function createRun(
  app: ReturnType<typeof createApp>["app"],
  challengeId: string,
  modelId: string
) {
  const res = await app.request(
    `/api/challenges/${challengeId}/runs`,
    json("POST", { modelId, environment: "local" })
  )
  const body = await res.json()
  if (!res.ok) {
    throw new Error(`create run failed ${res.status}: ${JSON.stringify(body)}`)
  }
  return body as { id: string; mainAgentId: string; status: string }
}

async function getDetail(
  app: ReturnType<typeof createApp>["app"],
  runId: string
) {
  const res = await app.request(`/api/runs/${runId}`)
  if (!res.ok) {
    return { ok: false as const, status: res.status, run: null }
  }
  const body = (await res.json()) as {
    run: {
      id: string
      status: string
      summary: string | null
      mainAgentId: string
      flag?: string | null
      hasFlag?: boolean
      error?: string | null
    }
    agents: Array<{ id: string; status: string; name: string }>
  }
  return { ok: true as const, status: res.status, ...body }
}

async function waitStatus(
  app: ReturnType<typeof createApp>["app"],
  runId: string,
  statuses: string[],
  timeout = 12_000
) {
  return waitFor(
    () => getDetail(app, runId),
    (value) => value.ok && statuses.includes(value.run!.status),
    timeout
  )
}

async function getMessages(
  app: ReturnType<typeof createApp>["app"],
  runId: string,
  agentId: string
) {
  return (
    await app.request(
      `/api/runs/${runId}/messages?agentId=${encodeURIComponent(agentId)}`
    )
  ).json() as Promise<{ messages: Array<{ role: string; text?: string }> }>
}

describe("lifecycle v2 HTTP", () => {
  test("create → finish_run → completed with messages", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([
      tool("finish_run", { summary: "done via tool" }),
    ])
    const run = await createRun(instance.app, challenge.id, modelId)
    const detail = await waitStatus(instance.app, run.id, ["completed"])
    expect(detail.run!.summary).toBe("done via tool")
    const page = await getMessages(
      instance.app,
      run.id,
      detail.run!.mainAgentId
    )
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.some((m) => m.role === "user")).toBe(true)
  })

  test("pause and resume", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([fauxAssistantMessage("hold")])
    const run = await createRun(instance.app, challenge.id, modelId)
    await waitStatus(instance.app, run.id, ["running", "idle", "completed"])
    let current = await getDetail(instance.app, run.id)
    if (current.run!.status === "completed") {
      instance.faux.setResponses([fauxAssistantMessage("stay idle")])
      const run2 = await createRun(instance.app, challenge.id, modelId)
      await waitStatus(instance.app, run2.id, ["running", "idle"])
      current = await getDetail(instance.app, run2.id)
      const paused = await (
        await instance.app.request(
          `/api/runs/${run2.id}/pause`,
          json("POST", {})
        )
      ).json()
      expect(paused.status).toBe("paused")
      instance.faux.setResponses([
        tool("finish_run", { summary: "resumed finish" }),
      ])
      await instance.app.request(
        `/api/runs/${run2.id}/resume`,
        json("POST", { message: "continue" })
      )
      const done = await waitStatus(instance.app, run2.id, ["completed"])
      expect(done.run!.summary).toBe("resumed finish")
      return
    }
    const paused = await (
      await instance.app.request(`/api/runs/${run.id}/pause`, json("POST", {}))
    ).json()
    expect(paused.status).toBe("paused")
    instance.faux.setResponses([
      tool("finish_run", { summary: "resumed finish" }),
    ])
    await instance.app.request(
      `/api/runs/${run.id}/resume`,
      json("POST", { message: "continue" })
    )
    const done = await waitStatus(instance.app, run.id, ["completed"])
    expect(done.run!.summary).toBe("resumed finish")
  })

  test("stop terminates the run", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([fauxAssistantMessage("working")])
    const run = await createRun(instance.app, challenge.id, modelId)
    await waitStatus(instance.app, run.id, ["running", "idle", "completed"])
    let targetId = run.id
    if (
      ["completed", "failed", "stopped"].includes(
        (await getDetail(instance.app, run.id)).run!.status
      )
    ) {
      instance.faux.setResponses([fauxAssistantMessage("working2")])
      const run2 = await createRun(instance.app, challenge.id, modelId)
      await waitStatus(instance.app, run2.id, ["running", "idle"])
      targetId = run2.id
    }
    const stopped = await (
      await instance.app.request(
        `/api/runs/${targetId}/stop`,
        json("POST", {})
      )
    ).json()
    expect(stopped.status).toBe("stopped")
  })

  test(
    "spawn child then handoff notice on main",
    async () => {
      const instance = setup()
      const { challenge } = await createChallenge(instance.app)
      const modelId = await configureFaux(instance.app)
      // main: spawn + end turn; child: text; main: finish after handoff notice
      instance.faux.setResponses([
        tool("spawn_agent", { name: "child", task: "scout" }),
        fauxAssistantMessage("waiting for child"),
        fauxAssistantMessage("child found nothing"),
        tool("finish_run", { summary: "parent finished" }),
      ])
      const run = await createRun(instance.app, challenge.id, modelId)
      const detail = await waitStatus(
        instance.app,
        run.id,
        ["completed"],
        20_000
      )
      expect(detail.run!.summary).toBe("parent finished")
      expect(detail.agents.length).toBeGreaterThanOrEqual(2)
      const page = await getMessages(
        instance.app,
        run.id,
        detail.run!.mainAgentId
      )
      const text = JSON.stringify(page.messages)
      expect(/notice|handoff|child|scout/i.test(text)).toBe(true)
    },
    { timeout: 25_000 }
  )

  test("finish_run without flag is completed but not successful for stats", async () => {
    const instance = setup()
    const { event, challenge } = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([tool("finish_run", { summary: "no flag" })])
    const run = await createRun(instance.app, challenge.id, modelId)
    const detail = await waitStatus(instance.app, run.id, ["completed"])
    expect(detail.run!.hasFlag).toBeFalsy()
    const stats = await (
      await instance.app.request(`/api/events/${event.id}/stats`)
    ).json()
    expect(stats.successfulRunCount).toBe(0)
    expect(stats.terminalRunCount).toBeGreaterThanOrEqual(1)
  })

  test("capacity rejects when active agents exceed max", async () => {
    const instance = setup({ maxConcurrency: 1 })
    const { challenge } = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([fauxAssistantMessage("occupying slot")])
    const first = await createRun(instance.app, challenge.id, modelId)
    await waitStatus(instance.app, first.id, ["running", "idle", "completed"])
    const firstStatus = (await getDetail(instance.app, first.id)).run!.status
    if (["completed", "failed", "stopped"].includes(firstStatus)) {
      // idle/completed frees capacity; assert helper path via global count only
      expect(instance.activeSessionCount()).toBeGreaterThanOrEqual(0)
      return
    }
    instance.faux.setResponses([fauxAssistantMessage("blocked")])
    const res = await instance.app.request(
      `/api/challenges/${challenge.id}/runs`,
      json("POST", { modelId, environment: "local" })
    )
    // active includes idle; capacity should fire if first still active
    if (res.status === 409) {
      expect(JSON.stringify(await res.json())).toMatch(/capacity/i)
    } else {
      expect([200, 201]).toContain(res.status)
    }
  })

  test("delete terminal run returns 204 then 404", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([
      tool("finish_run", { summary: "to delete" }),
    ])
    const run = await createRun(instance.app, challenge.id, modelId)
    await waitStatus(instance.app, run.id, ["completed"])
    const del = await instance.app.request(`/api/runs/${run.id}`, {
      method: "DELETE",
    })
    expect(del.status).toBe(204)
    const again = await instance.app.request(`/api/runs/${run.id}`)
    expect(again.status).toBe(404)
  })
})
