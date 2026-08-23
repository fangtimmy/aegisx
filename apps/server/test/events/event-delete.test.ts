import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
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
  return await responseJson<{ id: string }>(response)
}

/** Insert an agent row directly (the scheduler start path requires a live
 * model provider; the guard is DB-level so a raw row is the honest fixture). */
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
     values (?, ?, ?, ?, ?, 'm', 'sp', '[]', ?, null, null, 'manual', 3600000, ?, ?, ?)`,
    [
      agentId,
      eventId,
      challengeId,
      role,
      agentId,
      status,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  )
  return sqlite
}

describe("DELETE /api/events/:eventId — live agent guard", () => {
  test("blocks deletion while an orchestrator agent is live", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    // challengeId = NULL (orchestrator): the guard sees it via agents.eventId.
    const sqlite = insertAgent(
      dataDir,
      "sched-agent",
      event.id,
      "orchestrator",
      null,
      "running"
    )
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(409)
    // Scheduler terminal → deletion proceeds.
    sqlite.run(
      "update agents set status = 'completed' where id = 'sched-agent'"
    )
    sqlite.close()
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(204)
    expect((await app.request(`/api/events/${event.id}`)).status).toBe(404)
  })

  test("allows deletion with only a terminal scheduler agent", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    insertAgent(
      dataDir,
      "sched-agent",
      event.id,
      "orchestrator",
      null,
      "completed"
    ).close()
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(204)
  })
})
