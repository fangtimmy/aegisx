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

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-event-settings-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return { ...instance, dataDir: path }
}

async function createEvent(app: ReturnType<typeof createTestApp>["app"]) {
  const response = await app.request(
    "/api/events",
    json("POST", { name: "Ev" })
  )
  expect(response.status).toBe(201)
  return await responseJson<{ id: string }>(response)
}

/** Direct eventPlatforms row — bind() would dial the remote platform, the
 * projection under test only reads the row. */
function bindPlatform(dataDir: string, eventId: string) {
  const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
  const now = new Date().toISOString()
  sqlite.run(
    `insert into event_platforms (event_id, type, base_url, credential, remote_event_id, source_key, last_synced_at, created_at, updated_at)
     values (?, 'ctfd', 'http://ctf.example', 'secret', 'site', '["ctfd","http://ctf.example","site"]', null, ?, ?)`,
    [eventId, now, now]
  )
  sqlite.close()
}

describe("event PATCH partial updates", () => {
  test("saves promptHint alone (frontend sends only { promptHint })", async () => {
    const { app } = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { promptHint: "flag 格式为 moectf{...}" })
    )
    expect(response.status).toBe(200)
    const detail = await app.request(`/api/events/${event.id}`)
    expect((await detail.json()).event.promptHint).toBe(
      "flag 格式为 moectf{...}"
    )
  })

  test("saves name alone", async () => {
    const { app } = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "Renamed" })
    )
    expect(response.status).toBe(200)
    expect((await response.json()).name).toBe("Renamed")
  })

  test("saves name + promptHint together", async () => {
    const { app } = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "Renamed", promptHint: "hint" })
    )
    expect(response.status).toBe(200)
    const body = await responseJson<{ name: string; promptHint: string }>(
      response
    )
    expect(body.name).toBe("Renamed")
    expect(body.promptHint).toBe("hint")
  })

  test("response keeps the full EventSummary shape", async () => {
    const { app } = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "Renamed" })
    )
    expect(response.status).toBe(200)
    const body = await responseJson<Record<string, unknown>>(response)
    expect(Object.keys(body).toSorted()).toEqual([
      "activeAgentCount",
      "challengeCount",
      "createdAt",
      "id",
      "lastActivityAt",
      "name",
      "platform",
      "promptHint",
      "solvedCount",
      "updatedAt",
    ])
    expect(body.id).toBe(event.id)
    expect(body.name).toBe("Renamed")
    expect(body.platform).toBeNull()
    expect(body.challengeCount).toBe(0)
    expect(body.solvedCount).toBe(0)
    expect(body.activeAgentCount).toBe(0)
    expect(body.lastActivityAt).toBe(body.updatedAt)
  })

  test("rejects an empty provided name", async () => {
    const { app } = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "  " })
    )
    expect(response.status).toBe(400)
  })

  test("create still requires a name", async () => {
    const { app } = createTestApp()
    const response = await app.request(
      "/api/events",
      json("POST", { promptHint: "hint" })
    )
    expect(response.status).toBe(400)
  })
})

describe("GET /api/events/:eventId — missing id", () => {
  test("returns the shared 404 error shape", async () => {
    const { app } = createTestApp()
    const response = await app.request("/api/events/does-not-exist")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Event not found" },
    })
  })
})

describe("event platform projection", () => {
  test("list and detail carry the bound platform; unbound stays null", async () => {
    const { app, dataDir } = createTestApp()
    const unbound = await createEvent(app)
    const bound = await createEvent(app)
    bindPlatform(dataDir, bound.id)
    const { items } = await responseJson<{
      items: Array<{ id: string; platform: Record<string, unknown> | null }>
    }>(await app.request("/api/events"))
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get(bound.id)?.platform).toEqual({
      eventId: bound.id,
      type: "ctfd",
      baseUrl: "http://ctf.example",
      credential: "secret",
      remoteEventId: "site",
      lastSyncedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      credentialConfigured: true,
    })
    expect(byId.get(unbound.id)?.platform).toBeNull()
    const detail = await app.request(`/api/events/${bound.id}`)
    const { event } = await responseJson<{
      event: { platform: { credentialConfigured: boolean } | null }
    }>(detail)
    expect(event.platform?.credentialConfigured).toBe(true)
  })
})
