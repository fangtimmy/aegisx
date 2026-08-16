import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import { json } from "./support"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-providers-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

const providerBody = {
  label: "Test",
  type: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "real-key",
  enabled: true,
}

describe("provider API (model-runtime hygiene)", () => {
  test("POST /api/providers rejects $ENV-style apiKeys (models.json must carry a literal key)", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/providers",
      json("POST", { ...providerBody, apiKey: "$OPENAI_KEY" })
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("literal")
  })

  test("PATCH /api/providers/:id rejects $ENV-style apiKeys", async () => {
    const app = createTestApp()
    const created = await app.request(
      "/api/providers",
      json("POST", providerBody)
    )
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const patched = await app.request(
      `/api/providers/${id}`,
      json("PATCH", { apiKey: "$BAD" })
    )
    expect(patched.status).toBe(400)
  })

  test("POST /api/providers accepts a literal apiKey", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/providers",
      json("POST", providerBody)
    )
    expect(response.status).toBe(201)
  })
})
