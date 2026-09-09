import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"

import { registerWebApp } from "../../src/infrastructure/web-static"

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createWebApp() {
  const root = mkdtempSync(join(tmpdir(), "aegisx-web-"))
  tempDirs.push(root)
  writeFileSync(join(root, "index.html"), "<html>index</html>")
  const app = new Hono()
  registerWebApp(app, root)
  return app
}

describe("web static serving", () => {
  test("serves index.html for the root path", async () => {
    const response = await createWebApp().request("/")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("index")
  })

  test("malformed percent-encoding is a 404, not a 500", async () => {
    const response = await createWebApp().request("/%E0%A4%A")
    expect(response.status).toBe(404)
  })
})
