import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { createApp } from "../src/app"

const tempDirs: string[] = []
const closeApps: Array<() => void> = []
const configuredModels = new WeakMap<object, Promise<string>>()

afterEach(() => {
  for (const close of closeApps.splice(0)) close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function setup(maxConcurrency = 2, dataDir?: string, contextWindow = 128_000) {
  const root = dataDir ?? mkdtempSync(join(tmpdir(), "aegisx-phase-two-"))
  if (!dataDir) tempDirs.push(root)
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const instance = createApp({
    dataDir: root,
    maxConcurrency,
    models,
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
  test("isolates files, copies attachments, completes, and reloads messages", async () => {
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
    expect(first.faux.state.callCount).toBe(2)
    expect(JSON.stringify(detail.history)).not.toContain("flag{phase_two}")

    const sqlite = new Database(join(first.dataDir, "aegisx.sqlite"))
    const stored = sqlite
      .query(
        "select runs.id, runs.prompt, runs.model_config, runs.environment_config, runs.workspace_path from runs inner join run_agents on run_agents.run_id = runs.id and run_agents.parent_agent_id is null order by runs.created_at"
      )
      .all() as Array<Record<string, string>>
    expect(stored).toHaveLength(2)
    expect(stored[0].workspace_path).not.toBe(stored[1].workspace_path)
    expect(isAbsolute(stored[0].workspace_path)).toBe(false)
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
    }
    expect(
      sqlite.query("select count(*) as count from agent_messages").get()
    ).toMatchObject({ count: expect.any(Number) })
    sqlite.close()

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
    const idle = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          run: { status: string }
          agents: Array<{ parentAgentId: string | null; status: string }>
        }>,
      (detail) =>
        detail.agents.some(
          (agent) => agent.parentAgentId === null && agent.status === "idle"
        )
    )
    expect(idle.run.status).toBe("running")
    const rejectedWhileIdle = await createRun(instance.app, challenge.id)
    expect(rejectedWhileIdle.status).toBe(409)

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

  test("runs a background child agent and returns its result to main", async () => {
    const instance = setup(2)
    const { challenge } = await createChallenge(instance.app)
    instance.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("spawn_agent", {
          name: "Recon",
          task: "Inspect the challenge files and report one useful finding.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("delegated-result"),
      fauxAssistantMessage("delegated-result"),
      fauxAssistantMessage("delegated-result"),
    ])
    const run = await (await createRun(instance.app, challenge.id)).json()

    const detail = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          agents: Array<{
            id: string
            parentAgentId: string | null
            status: string
            summary: string | null
            usage: {
              input: number
              output: number
              cacheRead: number
              cacheWrite: number
              totalTokens: number
            }
          }>
          history: unknown[]
          stats: {
            input: number
            output: number
            cacheRead: number
            cacheWrite: number
            totalTokens: number
          }
        }>,
      (value) =>
        value.agents.some(
          (agent) =>
            agent.parentAgentId !== null && agent.status === "completed"
        ) && JSON.stringify(value.history).includes("Background agent Recon")
    )
    const child = detail.agents.find(
      (agent) => agent.parentAgentId !== null
    ) as (typeof detail.agents)[number]
    const main = detail.agents.find(
      (agent) => agent.parentAgentId === null
    ) as (typeof detail.agents)[number]
    expect(child.summary).toContain("delegated-result")
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ] as const) {
      expect(detail.stats[key]).toBe(
        detail.agents.reduce((total, agent) => total + agent.usage[key], 0)
      )
    }

    const childDetail = await (
      await instance.app.request(`/api/runs/${run.id}/agents/${child.id}`)
    ).json()
    expect(JSON.stringify(childDetail.history)).toContain("delegated-result")
    expect(JSON.stringify(childDetail.history)).not.toContain("call finish_run")
    expect(JSON.stringify(childDetail.history)).not.toContain(
      "Inspect the supplied bytes and finish the run."
    )
    expect(JSON.stringify(childDetail.history)).toContain(`agents/${child.id}/`)

    const childInspector = await (
      await instance.app.request(
        `/api/runs/${run.id}/agents/${child.id}/inspector`
      )
    ).json()
    expect(childInspector).toMatchObject({
      task: "Inspect the challenge files and report one useful finding.",
      runtime: { cwd: `$WORKSPACE/agents/${child.id}` },
    })
    expect(
      childInspector.runtime.tools.map((tool: { name: string }) => tool.name)
    ).not.toContain("finish_run")
    expect(childInspector.runtime.systemPrompt).toContain(
      "You are a background child agent."
    )
    expect(childInspector.runtime.systemPrompt).not.toContain(
      "expert coding assistant operating inside pi"
    )
    expect(childInspector.runtime.systemPrompt).not.toContain(
      "<available_skills>"
    )
    expect(JSON.stringify(childInspector)).not.toContain(instance.dataDir)
    expect(JSON.stringify(childInspector)).not.toContain(homedir())
    expect(JSON.stringify(childInspector)).not.toContain("test-only")

    const mainInspector = await (
      await instance.app.request(
        `/api/runs/${run.id}/agents/${main.id}/inspector`
      )
    ).json()
    expect(
      mainInspector.runtime.tools.map((tool: { name: string }) => tool.name)
    ).toEqual(expect.arrayContaining(["finish_run", "spawn_agent"]))
    expect(mainInspector.runtime.systemPrompt).toContain(
      "You are the main agent"
    )
    expect(mainInspector.runtime.systemPrompt).not.toContain(
      "<available_skills>"
    )
    expect(instance.activeSessionCount()).toBe(1)
    const sqlite = new Database(join(instance.dataDir, "aegisx.sqlite"))
    expect(
      sqlite
        .query(
          "select delivered_at from agent_inbox where agent_id = ? and kind = 'child_result'"
        )
        .get(main.id)
    ).toMatchObject({ delivered_at: expect.any(String) })
    sqlite.close()

    await instance.app.request(`/api/runs/${run.id}/stop`, json("POST", {}))
    expect(instance.activeSessionCount()).toBe(0)
  })

  test("marks the run failed when Pi returns an assistant error", async () => {
    const instance = setup()
    const { challenge } = await createChallenge(instance.app)
    instance.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider rejected the request",
      }),
    ])
    const run = await (await createRun(instance.app, challenge.id)).json()

    const detail = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          run: { status: string; error: string | null }
          agents: Array<{ parentAgentId: string | null; status: string }>
        }>,
      (value) => value.run.status === "failed"
    )
    expect(detail.run.error).toBe("provider rejected the request")
    expect(detail.agents).toContainEqual(
      expect.objectContaining({ parentAgentId: null, status: "failed" })
    )
    expect(instance.activeSessionCount()).toBe(0)
  })

  test("summarizes oversized context before the next request", async () => {
    const instance = setup(2, undefined, 200)
    const { challenge } = await createChallenge(instance.app)
    instance.faux.setResponses([fauxAssistantMessage("x".repeat(1000))])
    const run = await (await createRun(instance.app, challenge.id)).json()
    await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          agents: Array<{ parentAgentId: string | null; status: string }>
        }>,
      (value) =>
        value.agents.some(
          (agent) => agent.parentAgentId === null && agent.status === "idle"
        )
    )

    instance.faux.setResponses([
      fauxAssistantMessage("preserved findings"),
      fauxAssistantMessage("continued after compaction"),
    ])
    await instance.app.request(
      `/api/runs/${run.id}/message`,
      json("POST", { message: "Continue." })
    )
    const detail = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          history: unknown[]
        }>,
      (value) =>
        JSON.stringify(value.history).includes("continued after compaction")
    )
    expect(JSON.stringify(detail.history)).toContain(
      "continued after compaction"
    )

    const sqlite = new Database(join(instance.dataDir, "aegisx.sqlite"))
    expect(
      sqlite
        .query("select context_summary from run_agents where id = ?")
        .get(run.id)
    ).toEqual({ context_summary: "preserved findings" })
    expect(
      sqlite
        .query("select count(*) as count from agent_usage where agent_id = ?")
        .get(run.id)
    ).toEqual({ count: 1 })
    sqlite.close()
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
    sqlite.run(
      "insert into run_agents (id, run_id, name, status, created_at, updated_at) values ('interrupted', 'interrupted', 'Main agent', 'running', ?, ?)",
      [now, now]
    )
    sqlite.close()

    const second = setup(2, first.dataDir)
    const detail = await second.app.request("/api/runs/interrupted")
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      run: { status: "paused" },
      agents: [
        {
          id: "interrupted",
          parentAgentId: null,
          status: "paused",
        },
      ],
    })
  })
})
