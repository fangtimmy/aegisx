import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app"
import { json } from "./support"

const tempDirs: string[] = []
const closeDatabases: Array<() => void> = []

afterEach(() => {
  for (const close of closeDatabases.splice(0)) close()
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
    first.close()
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
