import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../../src/app"
import { responseJson } from "../../src/lib/guards"
import { NOTICE_TEMPLATE_DEFAULTS } from "../../src/orchestration/prompt-defaults"
import {
  NOTICE_TEMPLATE_VARIABLES,
  sampleNoticeContext,
} from "../../src/orchestration/prompt-templates"
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

type PreviewResponse = {
  segments: Array<{ id: number; text: string; highlighted: boolean }>
}

function preview(app: ReturnType<typeof createTestApp>, body: unknown) {
  return app.request("/api/settings/prompts/preview", json("POST", body))
}

const joined = (segments: PreviewResponse["segments"]) =>
  segments.map((segment) => segment.text).join("")

const highlighted = (segments: PreviewResponse["segments"]) =>
  segments.filter((segment) => segment.highlighted).map((s) => s.text)

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
    // The core templates must be seeded; the notice templates may grow.
    expect(builtinKeys).toEqual(
      expect.arrayContaining([
        "channelDelivery",
        "initial",
        "mainSystem",
        "orchestratorSystem",
        "schedulerDigest",
        "schedulerInitial",
      ])
    )
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

describe("settings meta notice contract", () => {
  test("meta carries all 10 notice defaults and the notice variable list", async () => {
    const app = createTestApp()
    const response = await app.request("/api/settings")
    expect(response.status).toBe(200)
    const { meta } = await responseJson<{
      meta: {
        promptTemplateDefaults: Record<string, string | undefined>
        noticePromptVariables: string[]
      }
    }>(response)
    expect(Object.keys(NOTICE_TEMPLATE_DEFAULTS)).toHaveLength(10)
    for (const [key, body] of Object.entries(NOTICE_TEMPLATE_DEFAULTS)) {
      expect(meta.promptTemplateDefaults[key]).toBe(body)
    }
    expect(meta.noticePromptVariables).toEqual([...NOTICE_TEMPLATE_VARIABLES])
    // The palette must be a subset of the preview sample context keys.
    for (const variable of meta.noticePromptVariables) {
      expect(Object.hasOwn(sampleNoticeContext, variable)).toBe(true)
    }
  })

  test('every shipped notice default previews through kind "notice"', async () => {
    const app = createTestApp()
    for (const body of Object.values(NOTICE_TEMPLATE_DEFAULTS)) {
      const response = await preview(app, { kind: "notice", template: body })
      expect(response.status).toBe(200)
      const { segments } = await responseJson<PreviewResponse>(response)
      expect(joined(segments)).not.toContain("{{")
    }
  })
})

describe("prompt preview API", () => {
  test('kind "notice" renders any notice* template against the sample context', async () => {
    const app = createTestApp()
    const response = await preview(app, {
      kind: "notice",
      template: NOTICE_TEMPLATE_DEFAULTS.noticeLaunchFailed,
    })
    expect(response.status).toBe(200)
    const { segments } = await responseJson<PreviewResponse>(response)
    const text = joined(segments)
    expect(text).toContain("启动失败：「web1」")
    expect(text).toContain("container start failed")
    expect(text).not.toContain("{{")
    // Interpolated values are highlighted (sample context, not the raw body).
    expect(highlighted(segments)).toContain("web1")
  })

  test('kind "notice" covers guarded notice variables (partial / stalled)', async () => {
    const app = createTestApp()
    for (const [template, fragment] of [
      [NOTICE_TEMPLATE_DEFAULTS.noticeFlagPartial, "已确认：flag{sample}"],
      [NOTICE_TEMPLATE_DEFAULTS.noticeEventStalled, "排水已 5m 无进展"],
    ] as const) {
      const response = await preview(app, { kind: "notice", template })
      expect(response.status).toBe(200)
      const { segments } = await responseJson<PreviewResponse>(response)
      expect(joined(segments)).toContain(fragment)
      expect(joined(segments)).not.toContain("{{")
    }
  })

  test("unknown preview kind is still rejected", async () => {
    const app = createTestApp()
    const response = await preview(app, {
      kind: "noticeSomething",
      template: "x",
    })
    expect(response.status).toBe(400)
  })
})
