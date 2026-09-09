import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import { responseJson } from "../src/lib/guards"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-errors-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance.app
}

describe("app.onError attribution", () => {
  test("malformed JSON body is a 400 invalid_json envelope, not a 500", async () => {
    const app = createTestApp()
    const response = await app.request("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    })
    expect(response.status).toBe(400)
    const body = await responseJson<{
      error: { code: string; message: string }
    }>(response)
    expect(body.error.code).toBe("invalid_json")
    expect(body.error.message).toContain("Malformed JSON")
  })
})
