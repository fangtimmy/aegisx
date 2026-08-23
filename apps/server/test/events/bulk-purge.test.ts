import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../../src/app"
import { responseJson } from "../../src/lib/guards"
import { json } from "../support"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-bulk-purge-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return { ...instance, dataDir: path }
}

async function createEvent(app: ReturnType<typeof createApp>["app"]) {
  const response = await app.request(
    "/api/events",
    json("POST", { name: "Ev" })
  )
  expect(response.status).toBe(201)
  return await responseJson<{ id: string }>(response)
}

async function createChallenge(
  app: ReturnType<typeof createApp>["app"],
  eventId: string,
  name: string
) {
  const response = await app.request(
    `/api/events/${eventId}/challenges`,
    json("POST", { name, description: "d" })
  )
  expect(response.status).toBe(201)
  return await responseJson<{ id: string }>(response)
}

/** Insert an agent row directly (the live spawn path needs a model provider;
 * the delete path is what is under test here). */
function insertAgent(
  dataDir: string,
  agentId: string,
  eventId: string,
  role: "solver" | "orchestrator",
  challengeId: string | null,
  status: string
) {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
  sqlite.run(
    `insert into agents (id, event_id, challenge_id, role, name, model, system_prompt, tools, status, session_file, prompt, source, timeout_ms, created_at, started_at, updated_at)
     values (?, ?, ?, ?, ?, 'm', 'sp', '[]', ?, null, null, ?, 3600000, ?, ?, ?)`,
    [
      agentId,
      eventId,
      challengeId,
      role,
      agentId,
      status,
      role === "orchestrator" ? "manual" : "manual",
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  )
  sqlite.close()
  // The challenge workspace's agents/<id8>/ dir lives on disk for solver agents.
  if (role === "solver" && challengeId) {
    const workspace = join(
      dataDir,
      "events",
      eventId,
      "challenges",
      challengeId,
      "workspace",
      "agents",
      agentId.slice(0, 8)
    )
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "notes.txt"), "wip")
  }
}

function insertQueueItem(
  dataDir: string,
  eventId: string,
  challengeId: string,
  status: string,
  agentId: string | null
) {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
  sqlite.run(
    `insert into spawn_queue (id, event_id, ord, challenge_id, params, prompt, source, status, agent_id, created_at, updated_at)
     values (?, ?, 1, ?, '{}', 'p', 'manual', ?, ?, ?, ?)`,
    [
      `q-${challengeId}-${status}`,
      eventId,
      challengeId,
      status,
      agentId,
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  )
  sqlite.close()
}

function countRows(dataDir: string, sql: string): number {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"), {
    readonly: true,
  })
  const count = sqlite.query<{ count: number }, []>(sql).get()!.count
  sqlite.close()
  return count
}

describe("DELETE /api/events/:eventId/challenges — bulk challenge purge", () => {
  test("blocks while a challenge-scoped agent is live", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id, "ch")
    insertAgent(dataDir, "a1", event.id, "solver", challenge.id, "running")

    const response = await app.request(`/api/events/${event.id}/challenges`, {
      method: "DELETE",
    })
    expect(response.status).toBe(409)
    const detail = await app.request(`/api/events/${event.id}`)
    expect(
      (await responseJson<{ challenges: unknown[] }>(detail)).challenges
    ).toHaveLength(1)
  })

  test("wipes challenges, flags, queue items and challenge agents; keeps event and scheduler agent", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id, "ch")

    const flag = await app.request(
      `/api/challenges/${challenge.id}/flags`,
      json("POST", { flag: "flag{a}" })
    )
    expect(flag.status).toBe(201)
    const uploaded = await app.request(
      `/api/challenges/${challenge.id}/attachments?filename=a.zip`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new TextEncoder().encode("bytes"),
      }
    )
    expect(uploaded.status).toBe(201)

    // A terminal challenge agent + a live scheduler agent + a pending queue
    // item tied to the challenge.
    insertAgent(dataDir, "a-ch", event.id, "solver", challenge.id, "completed")
    insertAgent(dataDir, "a-sched", event.id, "orchestrator", null, "running")
    insertQueueItem(dataDir, event.id, challenge.id, "pending", null)

    const response = await app.request(`/api/events/${event.id}/challenges`, {
      method: "DELETE",
    })
    expect(response.status).toBe(204)

    expect(countRows(dataDir, "select count(*) as count from challenges")).toBe(
      0
    )
    expect(
      countRows(dataDir, "select count(*) as count from challenge_flags")
    ).toBe(0)
    expect(
      countRows(dataDir, "select count(*) as count from attachments")
    ).toBe(0)
    // Queue items reference the deleted challenge — cascade sweeps them.
    expect(
      countRows(dataDir, "select count(*) as count from spawn_queue")
    ).toBe(0)
    // The challenge agent is gone (row + disk dir); the scheduler agent stays.
    expect(
      countRows(
        dataDir,
        "select count(*) as count from agents where id = 'a-ch'"
      )
    ).toBe(0)
    expect(
      existsSync(
        join(
          dataDir,
          "events",
          event.id,
          "challenges",
          challenge.id,
          "workspace",
          "agents"
        )
      )
    ).toBe(false)
    expect(
      countRows(
        dataDir,
        "select count(*) as count from agents where id = 'a-sched'"
      )
    ).toBe(1)
    expect(
      existsSync(join(dataDir, "attachments", event.id, challenge.id))
    ).toBe(false)
  })
})

describe("DELETE /api/events/:eventId/agents — bulk agent purge", () => {
  test("deletes every solver agent (keeps the scheduler with scope=all); keeps challenges, flags and pending queue items", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id, "ch")

    const flag = await app.request(
      `/api/challenges/${challenge.id}/flags`,
      json("POST", { flag: "flag{a}" })
    )
    expect(flag.status).toBe(201)

    // A live scheduler agent + two challenge agents: all solvers go, the
    // scheduler stays (scope=solver default).
    insertAgent(dataDir, "a-sched", event.id, "orchestrator", null, "running")
    insertAgent(dataDir, "a-ch1", event.id, "solver", challenge.id, "idle")
    insertAgent(dataDir, "a-ch2", event.id, "solver", challenge.id, "completed")
    insertQueueItem(dataDir, event.id, challenge.id, "running", "a-ch1")
    insertQueueItem(dataDir, event.id, challenge.id, "pending", null)

    const response = await app.request(`/api/events/${event.id}/agents`, {
      method: "DELETE",
    })
    expect(response.status).toBe(204)

    // The scheduler agent stays (default scope=solver).
    expect(countRows(dataDir, "select count(*) as count from agents")).toBe(1)
    expect(
      countRows(
        dataDir,
        "select count(*) as count from agents where role = 'orchestrator'"
      )
    ).toBe(1)
    // The launched queue item is cascade-removed with its agent; pending work
    // stays (FK on agents.id → the running item's agent is gone, so it goes
    // too; the pending item has agentId null → stays).
    expect(
      countRows(
        dataDir,
        "select count(*) as count from spawn_queue where status = 'pending'"
      )
    ).toBe(1)
    // Challenges and flags survive an agent purge.
    expect(countRows(dataDir, "select count(*) as count from challenges")).toBe(
      1
    )
    expect(
      countRows(dataDir, "select count(*) as count from challenge_flags")
    ).toBe(1)
  })
})
