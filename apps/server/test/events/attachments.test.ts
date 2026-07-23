import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
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
  const path = dataDir ?? mkdtempSync(join(tmpdir(), "aegisx-events-"))
  if (!dataDir) tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return { ...instance, dataDir: path }
}

async function createEvent(app: ReturnType<typeof createApp>["app"]) {
  const response = await app.request(
    "/api/events",
    json("POST", {
      name: "Spring CTF",
    })
  )
  expect(response.status).toBe(201)
  return response.json()
}

async function createChallenge(
  app: ReturnType<typeof createApp>["app"],
  eventId: string
) {
  const response = await app.request(
    `/api/events/${eventId}/challenges`,
    json("POST", {
      name: "Warmup",
      description: "Recover the flag from the attachment.",
      category: "misc",
      points: 100,
    })
  )
  expect(response.status).toBe(201)
  return response.json()
}

describe("event, challenge, and attachment API", () => {
  test("persists events and challenges across restart", async () => {
    const first = createTestApp()
    const event = await createEvent(first.app)
    await createChallenge(first.app, event.id)
    await first.close()
    closeDatabases.pop()

    const second = createTestApp(first.dataDir)
    const response = await second.app.request(`/api/events/${event.id}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.event).toMatchObject({
      name: "Spring CTF",
      challengeCount: 1,
    })
    expect(detail.challenges).toHaveLength(1)
    expect(detail.challenges[0]).toMatchObject({
      name: "Warmup",
      status: "not_started",
    })
  })

  test("summarizes event progress and active runs", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id)
    const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
    sqlite.run(
      "insert into challenge_remote (challenge_id, source_key, remote_id, available, solved, target_supported, target_ignored, target_count, target_info, synced_at) values (?, 'source', 'remote-1', 1, 1, 0, 0, 0, '[]', ?)",
      [challenge.id, "2099-01-01T00:00:00.000Z"]
    )
    sqlite.run(
      "insert into runs (id, challenge_id, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
      [
        "paused-run",
        challenge.id,
        "paused",
        "2100-01-01T00:00:00.000Z",
        "2100-01-01T00:00:00.000Z",
      ]
    )
    sqlite.close()

    const response = await app.request("/api/events")
    expect(response.status).toBe(200)
    expect((await response.json()).items[0]).toMatchObject({
      id: event.id,
      challengeCount: 1,
      solvedCount: 1,
      activeRunCount: 1,
      lastActivityAt: "2100-01-01T00:00:00.000Z",
    })
  })

  test("derives local challenge progress from completed runs", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id)
    const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
    sqlite.run(
      "insert into runs (id, challenge_id, status, created_at, updated_at) values (?, ?, 'completed', ?, ?)",
      [
        "completed-local-run",
        challenge.id,
        "2100-01-01T00:00:00.000Z",
        "2100-01-01T00:00:00.000Z",
      ]
    )
    sqlite.close()

    const detail = await (await app.request(`/api/events/${event.id}`)).json()
    expect(detail.event.solvedCount).toBe(1)
    expect(detail.challenges[0]).toMatchObject({
      runCount: 1,
      status: "solved",
    })
  })

  test("enforces the configured attachment size limit", async () => {
    const { app } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id)
    const settings = await (await app.request("/api/settings")).json()
    const updated = await app.request(
      "/api/settings",
      json("PATCH", {
        defaultModelId: settings.defaultModelId,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        environment: settings.environment,
        containerImage: settings.containerImage,
        cpus: settings.cpus,
        memoryMb: settings.memoryMb,
        pidsLimit: settings.pidsLimit,
        maxConcurrency: settings.maxConcurrency,
        maxAttachmentMb: 1,
      })
    )
    expect(updated.status).toBe(200)
    const response = await app.request(
      `/api/challenges/${challenge.id}/attachments?filename=large.bin`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(1024 * 1024 + 1),
      }
    )
    expect(response.status).toBe(413)
  })

  test("streams attachments, rejects path names, and cleans deleted events", async () => {
    const { app, dataDir } = createTestApp()
    const event = await createEvent(app)
    const challenge = await createChallenge(app, event.id)
    const bytes = new TextEncoder().encode("PK\u0003\u0004\u0000binary\u00ff")

    for (const filename of ["../flag.txt", "folder/file.txt", ".", ".."]) {
      const rejected = await app.request(
        `/api/challenges/${challenge.id}/attachments?filename=${encodeURIComponent(filename)}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        }
      )
      expect(rejected.status).toBe(400)
    }

    const uploaded = await app.request(
      `/api/challenges/${challenge.id}/attachments?filename=challenge.zip`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }
    )
    expect(uploaded.status).toBe(201)
    const attachment = await uploaded.json()
    expect(attachment).toMatchObject({
      originalName: "challenge.zip",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
    expect(JSON.stringify(attachment)).not.toContain(dataDir)

    const downloaded = await app.request(attachment.downloadUrl)
    expect(downloaded.status).toBe(200)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes)

    const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
    sqlite.run(
      "insert into runs (id, challenge_id, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
      [
        "active-run",
        challenge.id,
        "running",
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    )
    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(409)
    sqlite.run("update runs set status = 'stopped' where id = 'active-run'")
    sqlite.close()

    expect(
      (await app.request(`/api/events/${event.id}`, { method: "DELETE" }))
        .status
    ).toBe(204)
    expect(existsSync(join(dataDir, "attachments", event.id))).toBe(false)
    expect((await app.request(`/api/events/${event.id}`)).status).toBe(404)
  })

  test("validates event names", async () => {
    const { app } = createTestApp()
    const blank = await app.request(
      "/api/events",
      json("POST", { name: "   " })
    )
    expect(blank.status).toBe(400)

    const extraFields = await app.request(
      "/api/events",
      json("POST", {
        name: "Only name",
        description: "Not accepted",
      })
    )
    expect(extraFields.status).toBe(400)
  })
})
