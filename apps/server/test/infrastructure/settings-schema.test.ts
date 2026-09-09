import { describe, expect, test } from "bun:test"

import {
  defaultSettings,
  isSettingModified,
  parseSettings,
  patchSettings,
} from "@aegisx/shared"

describe("settings schema", () => {
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
})
