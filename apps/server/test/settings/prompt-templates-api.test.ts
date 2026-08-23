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
  const path = mkdtempSync(join(tmpdir(), "aegisx-templates-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

describe("prompt template store API", () => {
  test("GET lists the seeded builtin templates", async () => {
    const app = createTestApp()
    const response = await app.request("/api/prompt-templates")
    expect(response.status).toBe(200)
    const { items } = await responseJson<{
      items: Array<{ plugin: string; key: string; body: string }>
    }>(response)
    expect(items.length).toBeGreaterThanOrEqual(4)
    const builtinKeys = items
      .filter((item) => item.plugin === "builtin")
      .map((item) => item.key)
      .toSorted()
    expect(builtinKeys).toEqual([
      "channelDelivery",
      "initial",
      "mainSystem",
      "orchestratorSystem",
      "schedulerDigest",
      "schedulerInitial",
    ])
  })

  test("PATCH upserts a (plugin, key) row and is readable on GET", async () => {
    const app = createTestApp()

    const patch = await app.request(
      "/api/prompt-templates",
      json("PATCH", {
        plugin: "builtin",
        key: "mainSystem",
        body: "You are a solver for {{challenge.name}}.",
      })
    )
    expect(patch.status).toBe(200)

    const response = await app.request("/api/prompt-templates")
    const { items } = await responseJson<{
      items: Array<{ plugin: string; key: string; body: string }>
    }>(response)
    const row = items.find(
      (item) => item.plugin === "builtin" && item.key === "mainSystem"
    )
    expect(row?.body).toBe("You are a solver for {{challenge.name}}.")
  })

  test("PATCH inserts a brand-new plugin key", async () => {
    const app = createTestApp()
    const patch = await app.request(
      "/api/prompt-templates",
      json("PATCH", {
        plugin: "trio",
        key: "observerSystem",
        body: "Watch the solver.",
      })
    )
    expect(patch.status).toBe(200)
    const { items } = await responseJson<{
      items: Array<{ plugin: string; key: string; body: string }>
    }>(patch)
    expect(
      items.find(
        (item) => item.plugin === "trio" && item.key === "observerSystem"
      )?.body
    ).toBe("Watch the solver.")
  })

  test("PATCH rejects an empty plugin/key or oversized body", async () => {
    const app = createTestApp()
    for (const body of [
      { plugin: "", key: "mainSystem", body: "x" },
      { plugin: "builtin", key: "", body: "x" },
      { plugin: "builtin", key: "mainSystem", body: "x".repeat(100_001) },
    ]) {
      const response = await app.request(
        "/api/prompt-templates",
        json("PATCH", body)
      )
      expect(response.status).toBe(400)
    }
  })
})
