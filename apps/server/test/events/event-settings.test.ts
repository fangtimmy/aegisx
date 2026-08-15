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

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-event-settings-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

async function createEvent(app: ReturnType<typeof createTestApp>) {
  const response = await app.request(
    "/api/events",
    json("POST", { name: "Ev" })
  )
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

describe("event PATCH partial updates", () => {
  test("saves promptHint alone (frontend sends only { promptHint })", async () => {
    const app = createTestApp()
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
    const app = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "Renamed" })
    )
    expect(response.status).toBe(200)
    expect((await response.json()).name).toBe("Renamed")
  })

  test("saves name + promptHint together", async () => {
    const app = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "Renamed", promptHint: "hint" })
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { name: string; promptHint: string }
    expect(body.name).toBe("Renamed")
    expect(body.promptHint).toBe("hint")
  })

  test("rejects an empty provided name", async () => {
    const app = createTestApp()
    const event = await createEvent(app)
    const response = await app.request(
      `/api/events/${event.id}`,
      json("PATCH", { name: "  " })
    )
    expect(response.status).toBe(400)
  })

  test("create still requires a name", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/events",
      json("POST", { promptHint: "hint" })
    )
    expect(response.status).toBe(400)
  })
})
