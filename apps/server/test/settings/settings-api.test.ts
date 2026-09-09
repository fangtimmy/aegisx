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
  const path = mkdtempSync(join(tmpdir(), "aegisx-settings-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

type SettingsResponse = { settings: Record<string, unknown> }
type ErrorResponse = { error: { code: string; message: string } }

describe("settings API", () => {
  test("PATCH applies a valid value", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/settings",
      json("PATCH", { "scheduler.maxConcurrentAgents": 8 })
    )
    expect(response.status).toBe(200)
    const { settings } = await responseJson<SettingsResponse>(response)
    expect(settings["scheduler.maxConcurrentAgents"]).toBe(8)
  })

  test("PATCH rejects an out-of-range value with 400 naming the key", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/settings",
      json("PATCH", { "scheduler.maxConcurrentAgents": 999 })
    )
    expect(response.status).toBe(400)
    const { error } = await responseJson<ErrorResponse>(response)
    expect(error?.message).toContain("scheduler.maxConcurrentAgents")

    const after = await app.request("/api/settings")
    const { settings } = await responseJson<SettingsResponse>(after)
    expect(settings["scheduler.maxConcurrentAgents"]).toBe(4)
  })

  test("PATCH rejects unknown keys instead of silently dropping them", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/settings",
      json("PATCH", { "prompts.mainSystem": "stale key" })
    )
    expect(response.status).toBe(400)
    const { error } = await responseJson<ErrorResponse>(response)
    expect(error?.message).toContain("prompts.mainSystem")
  })

  test("PATCH rejects a mixed batch wholesale", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/settings",
      json("PATCH", {
        "container.cpus": 4,
        "container.memoryMb": "lots",
      })
    )
    expect(response.status).toBe(400)

    const after = await app.request("/api/settings")
    const { settings } = await responseJson<SettingsResponse>(after)
    expect(settings["container.cpus"]).toBe(2)
  })

  test("PATCH clears the default model ref with null", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/settings",
      json("PATCH", { "agent.defaultModelRef": null })
    )
    expect(response.status).toBe(200)
    const { settings } = await responseJson<SettingsResponse>(response)
    expect(settings["agent.defaultModelRef"]).toBeNull()
  })
})
