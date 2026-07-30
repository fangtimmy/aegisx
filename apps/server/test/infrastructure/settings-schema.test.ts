import { describe, expect, test } from "bun:test"
import {
  defaultSettings,
  get,
  isSettingModified,
  migrateLegacySettings,
  parseSettings,
  patchSettings,
  toolTimeoutMs,
} from "../../../shared"

describe("settings schema", () => {
  test("get falls back to defaults", () => {
    expect(get({}, "runtime.maxConcurrency")).toBe(2)
    expect(get(defaultSettings(), "runtime.maxConcurrency")).toBe(2)
  })

  test("parseSettings drops unknown keys and invalid values", () => {
    const parsed = parseSettings({
      "runtime.maxConcurrency": 99,
      "runtime.environment": "nope",
      unknown: true,
    })
    // out of range / invalid enum → defaults
    expect(parsed["runtime.maxConcurrency"]).toBe(2)
    expect(parsed["runtime.environment"]).toBe("local")
    expect(Object.hasOwn(parsed, "unknown")).toBe(false)
  })

  test("parseSettings accepts valid values including blank prompts", () => {
    const parsed = parseSettings({
      "runtime.maxConcurrency": 7,
      "agent.defaultModelId": "m1",
      "container.cpus": 1.5,
      "prompts.mainSystem": "",
    })
    expect(parsed["runtime.maxConcurrency"]).toBe(7)
    expect(parsed["agent.defaultModelId"]).toBe("m1")
    expect(parsed["container.cpus"]).toBe(1.5)
    expect(parsed["prompts.mainSystem"]).toBe("")
    expect(isSettingModified(parsed, "prompts.mainSystem")).toBe(true)
  })

  test("patchSettings merges partial updates", () => {
    const base = defaultSettings()
    const next = patchSettings(base, { "runtime.maxConcurrency": 4 })
    expect(next["runtime.maxConcurrency"]).toBe(4)
    expect(next["runtime.environment"]).toBe(base["runtime.environment"])
    expect(isSettingModified(next, "runtime.maxConcurrency")).toBe(true)
    expect(isSettingModified(base, "runtime.maxConcurrency")).toBe(false)
  })

  test("toolTimeoutMs resolves per-tool keys", () => {
    const settings = {
      ...defaultSettings(),
      "tools.defaultTimeoutMs": 30_000,
      "tools.timeout.bash": 120_000,
    }
    expect(toolTimeoutMs(settings, "bash")).toBe(120_000)
    expect(toolTimeoutMs(settings, "read")).toBe(30_000)
  })

  test("migrateLegacySettings maps old keys", () => {
    const migrated = migrateLegacySettings({
      defaultModelId: "m1",
      maxConcurrency: 20,
      environment: "container",
      containerImage: "aegisx/solver:kali",
      mainSystemPromptTemplate: "custom main",
      childSystemPromptTemplate: "",
      toolTimeouts: { bash: 99_000 },
    })
    expect(migrated["agent.defaultModelId"]).toBe("m1")
    expect(migrated["runtime.maxConcurrency"]).toBe(20)
    expect(migrated["runtime.environment"]).toBe("container")
    expect(migrated["container.image"]).toBe("aegisx/solver:kali")
    expect(migrated["prompts.mainSystem"]).toBe("custom main")
    // legacy empty prompt → materialize schema default
    expect(migrated["prompts.childSystem"]).toBe(
      defaultSettings()["prompts.childSystem"]
    )
    expect(migrated["tools.timeout.bash"]).toBe(99_000)
  })
})
