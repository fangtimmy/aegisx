import { describe, expect, test } from "bun:test"

import { deriveCapabilities } from "../../src/orchestration/types"

describe("deriveCapabilities (spec §3.7)", () => {
  test("empty tool list → all false", () => {
    expect(deriveCapabilities([])).toEqual({
      canFinish: false,
      canSubmitFlag: false,
      canManageTarget: false,
      canSpawn: false,
    })
  })

  test("finish_run → canFinish only", () => {
    expect(deriveCapabilities(["finish_run"])).toMatchObject({
      canFinish: true,
      canSubmitFlag: false,
      canManageTarget: false,
      canSpawn: false,
    })
  })

  test("submit_flag → canSubmitFlag", () => {
    expect(deriveCapabilities(["submit_flag"]).canSubmitFlag).toBe(true)
  })

  test("any *_target → canManageTarget (all four verbs)", () => {
    for (const name of [
      "get_target",
      "start_target",
      "extend_target",
      "stop_target",
    ]) {
      expect(deriveCapabilities([name]).canManageTarget).toBe(true)
    }
  })

  test("spawn_agent → canSpawn", () => {
    expect(deriveCapabilities(["spawn_agent"]).canSpawn).toBe(true)
  })

  test("bootstrap-style set (no finish_run) → canFinish=false", () => {
    // bootstrap-solver's probe agent has target+flag tools but NO finish_run.
    const caps = deriveCapabilities([
      "submit_flag",
      "get_target",
      "start_target",
      "stop_target",
      "extend_target",
    ])
    expect(caps.canFinish).toBe(false)
    expect(caps.canSubmitFlag).toBe(true)
    expect(caps.canManageTarget).toBe(true)
  })

  test("classic full set → all true", () => {
    const caps = deriveCapabilities([
      "finish_run",
      "submit_flag",
      "get_target",
      "start_target",
      "extend_target",
      "stop_target",
      "spawn_agent",
      "read_agent",
    ])
    expect(caps).toEqual({
      canFinish: true,
      canSubmitFlag: true,
      canManageTarget: true,
      canSpawn: true,
    })
  })
})
