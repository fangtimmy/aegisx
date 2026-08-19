import { describe, expect, test } from "bun:test"

import {
  defaultSettings,
  get,
  isSettingModified,
  migrateLegacySettings,
  parseSettings,
  patchSettings,
} from "@aegisx/shared"

describe("settings schema", () => {
  test("get falls back to defaults", () => {
    expect(get({}, "runtime.maxAttachmentMb")).toBe(512)
    expect(get(defaultSettings(), "runtime.maxAttachmentMb")).toBe(512)
  })

  test("parseSettings drops unknown keys and invalid values", () => {
    const parsed = parseSettings({
      "runtime.maxAttachmentMb": 99_999,
      unknown: true,
    })
    // out of range → default
    expect(parsed["runtime.maxAttachmentMb"]).toBe(512)
    expect(Object.hasOwn(parsed, "unknown")).toBe(false)
  })

  test("parseSettings accepts valid values and drops legacy prompt keys", () => {
    const parsed = parseSettings({
      "runtime.maxAttachmentMb": 1024,
      "agent.defaultModelRef": "aegisx-prov-1/gpt-4o-mini:off",
      "container.cpus": 1.5,
      "prompts.mainSystem": "",
    })
    expect(parsed["runtime.maxAttachmentMb"]).toBe(1024)
    expect(parsed["agent.defaultModelRef"]).toBe(
      "aegisx-prov-1/gpt-4o-mini:off"
    )
    expect(parsed["container.cpus"]).toBe(1.5)
    // prompts.* left FlatSettings in v8 (templates live in prompt_templates).
    expect(Object.hasOwn(parsed, "prompts.mainSystem")).toBe(false)
  })

  test("patchSettings merges partial updates", () => {
    const base = defaultSettings()
    const next = patchSettings(base, { "runtime.maxAttachmentMb": 2048 })
    expect(next["runtime.maxAttachmentMb"]).toBe(2048)
    expect(next["container.image"]).toBe(base["container.image"])
    expect(isSettingModified(next, "runtime.maxAttachmentMb")).toBe(true)
    expect(isSettingModified(base, "runtime.maxAttachmentMb")).toBe(false)
  })

  test("migrateLegacySettings maps old keys and drops removed ones", () => {
    const migrated = migrateLegacySettings({
      defaultModelId: "m1",
      // v2-only keys with no v3 equivalent are dropped silently.
      maxConcurrency: 20,
      environment: "container",
      toolTimeouts: { bash: 99_000 },
      maxAttachmentMb: 256,
      containerImage: "aegisx/solver:kali",
      // v2-era prompt templates left FlatSettings in v8 (prompt_templates
      // table); the legacy extractor carries them into the DB at boot instead.
      mainSystemPromptTemplate: "custom main",
    })
    expect(migrated["agent.defaultModelRef"]).toBe("m1")
    expect(migrated["runtime.maxAttachmentMb"]).toBe(256)
    expect(migrated["container.image"]).toBe("aegisx/solver:kali")
    // removed v2 settings are absent from the flat shape
    expect(Object.hasOwn(migrated, "prompts.mainSystem")).toBe(false)
    expect(Object.hasOwn(migrated, "runtime.maxConcurrency")).toBe(false)
    expect(Object.hasOwn(migrated, "runtime.environment")).toBe(false)
    expect(Object.hasOwn(migrated, "tools.timeout.bash")).toBe(false)
  })
})
