import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../../src/app"
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
  const response = await app.request("/api/events", json("POST", { name: "Ev" }))
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
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
  return (await response.json()) as { id: string }
}

/** Insert a run row + its on-disk run dir directly (the live start path needs
 * a model provider; the delete path is what is under test here). */
function insertRun(
  dataDir: string,
  runId: string,
  eventId: string,
  scopeType: "event" | "challenge",
  challengeId: string | null,
  status: string
) {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
  sqlite.run(
    "insert into runs (id, scope_type, event_id, challenge_id, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) values (?, ?, ?, ?, ?, 'm', 'img', 1, 512, 64, ?, 'runs/x/workspace', 'runs/x/sessions', 'scheduler', ?, ?)",
    [
      runId,
      scopeType,
      eventId,
      challengeId,
      status,
      `c-${runId}`,
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  )
  sqlite.close()
  const workspace = join(dataDir, "runs", runId, "workspace")
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, "notes.txt"), "wip")
}

function insertQueueItem(
  dataDir: string,
  eventId: string,
  challengeId: string,
  status: string,
  runId: string | null
) {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
  sqlite.run(
    "insert into run_queue (id, event_id, ord, challenge_id, params, prompt, source, status, run_id, created_at, updated_at) values (?, ?, 1, ?, '{}', 'p', 'manual', ?, ?, ?, ?)",
    [
      `q-${challengeId}-${status}`,
      eventId,
      challengeId,
      status,
      runId,
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  )
  sqlite.close()
}

function countRows(dataDir: string, sql: string): number {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"), { readonly: true })
  const count = (sqlite.query(sql).get() as { count: number }).count
  sqlite.close()
  return count
}

describe("DELETE /api/events/:eventId/challenges — bulk challenge purge", () => {
  test("blocks while a challenge-scoped run is live", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id, "ch")
    insertRun(dataDir, "r1", event.id, "challenge", challenge.id, "running")

    const response = await app.request(`/api/events/${event.id}/challenges`, {
      method: "DELETE",
    })
    expect(response.status).toBe(409)
    const detail = await app.request(`/api/events/${event.id}`)
    expect(((await detail.json()) as { challenges: unknown[] }).challenges)
      .toHaveLength(1)
  })

  test("wipes challenges, flags, queue items and challenge runs; keeps event and scheduler run", async () => {
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

    // Closed challenge run (workspace dir on disk) + live event-scope
    // scheduler run + a pending queue item tied to the challenge.
    insertRun(dataDir, "r-ch", event.id, "challenge", challenge.id, "closed")
    insertRun(dataDir, "r-sched", event.id, "event", null, "running")
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
    expect(countRows(dataDir, "select count(*) as count from attachments")).toBe(
      0
    )
    // Queue items reference the deleted challenge — cascade sweeps them.
    expect(countRows(dataDir, "select count(*) as count from run_queue")).toBe(0)
    // The challenge run is gone (row + disk dir); the scheduler run stays.
    expect(
      countRows(
        dataDir,
        "select count(*) as count from runs where id = 'r-ch'"
      )
    ).toBe(0)
    expect(existsSync(join(dataDir, "runs", "r-ch"))).toBe(false)
    expect(
      countRows(
        dataDir,
        "select count(*) as count from runs where id = 'r-sched'"
      )
    ).toBe(1)
    expect(
      existsSync(join(dataDir, "attachments", event.id, challenge.id))
    ).toBe(false)
  })
})

describe("DELETE /api/events/:eventId/runs — bulk run purge", () => {
  test("deletes every run (scheduler first), their disk dirs, and queued run references; keeps challenges, flags and pending queue items", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id, "ch")

    const flag = await app.request(
      `/api/challenges/${challenge.id}/flags`,
      json("POST", { flag: "flag{a}" })
    )
    expect(flag.status).toBe(201)

    // A live scheduler run + a closed challenge run: both go, no guard.
    insertRun(dataDir, "r-sched", event.id, "event", null, "running")
    insertRun(dataDir, "r-ch", event.id, "challenge", challenge.id, "idle")
    insertQueueItem(dataDir, event.id, challenge.id, "running", "r-ch")
    insertQueueItem(dataDir, event.id, challenge.id, "pending", null)

    const response = await app.request(`/api/events/${event.id}/runs`, {
      method: "DELETE",
    })
    expect(response.status).toBe(204)

    expect(countRows(dataDir, "select count(*) as count from runs")).toBe(0)
    expect(existsSync(join(dataDir, "runs", "r-sched"))).toBe(false)
    expect(existsSync(join(dataDir, "runs", "r-ch"))).toBe(false)
    // Launched queue item cascade-deletes with its run; pending work stays.
    expect(countRows(dataDir, "select count(*) as count from run_queue")).toBe(
      1
    )
    expect(
      countRows(
        dataDir,
        "select count(*) as count from run_queue where status = 'pending'"
      )
    ).toBe(1)
    // Challenges and flags survive a run purge.
    expect(countRows(dataDir, "select count(*) as count from challenges")).toBe(
      1
    )
    expect(
      countRows(dataDir, "select count(*) as count from challenge_flags")
    ).toBe(1)
  })
})
