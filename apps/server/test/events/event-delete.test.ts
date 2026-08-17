import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
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

function createTestApp(dataDir?: string) {
  const path = dataDir ?? mkdtempSync(join(tmpdir(), "aegisx-event-delete-"))
  if (!dataDir) tempDirs.push(path)
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
  return (await response.json()) as { id: string }
}

/** Insert a run row directly (the scheduler start path requires a live model
 * provider; the guard is DB-level so a raw row is the honest fixture). */
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
    "insert into runs (id, scope_type, event_id, challenge_id, status, model, image, cpus, memory_mb, pids_limit, container_name, workspace_path, session_dir, source, created_at, updated_at) values (?, ?, ?, ?, ?, 'm', 'img', 1, 512, 64, 'c', 'runs/x/workspace', 'runs/x/sessions', 'scheduler', ?, ?)",
    [
      runId,
      scopeType,
      eventId,
      challengeId,
      status,
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  )
  return sqlite
}

describe("DELETE /api/events/:eventId — live run guard", () => {
  test("blocks deletion while an event-scope scheduler run is live", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    // challengeId = NULL: the challenge innerJoin guard cannot see this row —
    // the C1 regression (deleting under a live scheduler orphaned the run).
    const sqlite = insertRun(
      dataDir,
      "sched-run",
      event.id,
      "event",
      null,
      "running"
    )
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(409)
    // Scheduler stopped (closed) → deletion proceeds.
    sqlite.run("update runs set status = 'closed' where id = 'sched-run'")
    sqlite.close()
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(204)
    expect((await app.request(`/api/events/${event.id}`)).status).toBe(404)
  })

  test("allows deletion with only a closed scheduler run", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    insertRun(dataDir, "sched-run", event.id, "event", null, "closed").close()
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(204)
  })
})
