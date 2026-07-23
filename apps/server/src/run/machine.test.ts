import { describe, expect, test } from "bun:test"
import type { FrozenPromptConfig, ModelConfig } from "../../../shared"
import { activeAgentCount, pausedAgentCount, reduce } from "./machine"
import type { Cmd, RunAggregate } from "./types"

const model: ModelConfig = {
  provider: "test",
  modelId: "m1",
  thinkingLevel: "off",
}

const prompt: FrozenPromptConfig = {
  mainSystemPromptTemplate: "main",
  childSystemPromptTemplate: "child",
  initialPromptTemplate: "init",
}

const now = "2026-07-23T00:00:00.000Z"
const later = "2026-07-23T00:01:00.000Z"

function createCmd(overrides?: Partial<Extract<Cmd, { t: "create" }>>): Cmd {
  return {
    t: "create",
    runId: "run-1",
    mainAgentId: "main-1",
    challengeId: "ch-1",
    model,
    env: { type: "local" },
    prompt,
    workspacePath: "workspaces/run-1",
    bootstrapText: "Solve the challenge",
    bootstrapMessageId: "msg-boot",
    now,
    ...overrides,
  }
}

function created(): RunAggregate {
  const result = reduce(null, createCmd())
  if (!result.ok) throw new Error(result.message)
  return result.state
}

describe("reduce create", () => {
  test("creates running run with main agent and bootstrap effects", () => {
    const result = reduce(null, createCmd())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("running")
    expect(result.state.mainAgentId).toBe("main-1")
    expect(result.state.agents).toHaveLength(1)
    expect(result.state.agents[0]?.status).toBe("running")
    expect(result.effects.map((e) => e.t)).toEqual([
      "insert_message",
      "attach",
      "dispatch",
    ])
  })

  test("rejects create when state exists", () => {
    const result = reduce(created(), createCmd())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("invalid_state")
  })
})

describe("reduce pause / resume / stop", () => {
  test("pause from running", () => {
    const result = reduce(created(), { t: "pause", now: later })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("paused")
    expect(result.state.agents[0]?.status).toBe("paused")
    expect(result.effects.map((e) => e.t)).toEqual(["abort_all", "release_all"])
  })

  test("pause rejects when not running", () => {
    const paused = reduce(created(), { t: "pause", now: later })
    if (!paused.ok) throw new Error("setup")
    const result = reduce(paused.state, { t: "pause", now: later })
    expect(result.ok).toBe(false)
  })

  test("resume restarts main and children", () => {
    let state = created()
    const spawn = reduce(state, {
      t: "spawn",
      agentId: "child-1",
      parentId: "main-1",
      name: "Worker",
      task: "do work",
      taskMessageId: "msg-task",
      now: later,
    })
    if (!spawn.ok) throw new Error(spawn.message)
    state = spawn.state
    const paused = reduce(state, { t: "pause", now: later })
    if (!paused.ok) throw new Error(paused.message)
    expect(pausedAgentCount(paused.state)).toBe(2)

    const result = reduce(paused.state, {
      t: "resume",
      text: "continue please",
      messageId: "msg-resume",
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("running")
    expect(activeAgentCount(result.state)).toBe(2)
    const kinds = result.effects.map((e) => e.t)
    expect(kinds.filter((t) => t === "attach")).toHaveLength(2)
    expect(kinds.filter((t) => t === "dispatch")).toHaveLength(2)
  })

  test("stop terminates non-terminal agents", () => {
    const result = reduce(created(), { t: "stop", now: later })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("stopped")
    expect(result.state.agents[0]?.status).toBe("stopped")
    expect(result.state.completedAt).toBe(later)
  })
})

describe("reduce main settled", () => {
  test("success without finish → idle", () => {
    const result = reduce(created(), {
      t: "main_settled",
      outcome: { status: "success", summary: "partial", error: null },
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("running")
    expect(result.state.agents[0]?.status).toBe("idle")
    expect(result.effects).toEqual([])
  })

  test("success with pending finish → completed", () => {
    let state = created()
    const fin = reduce(state, { t: "request_finish", summary: "flag{x}" })
    if (!fin.ok) throw new Error(fin.message)
    state = fin.state
    const result = reduce(state, {
      t: "main_settled",
      outcome: { status: "success", summary: null, error: null },
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("completed")
    expect(result.state.summary).toBe("flag{x}")
    expect(result.state.pendingFinishSummary).toBeNull()
    expect(result.state.agents[0]?.status).toBe("completed")
    expect(result.effects.some((e) => e.t === "release_all")).toBe(true)
  })

  test("error → failed run", () => {
    const result = reduce(created(), {
      t: "main_settled",
      outcome: { status: "error", summary: null, error: "boom" },
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("failed")
    expect(result.state.error).toBe("boom")
    expect(result.state.agents[0]?.status).toBe("failed")
  })

  test("stops children when main fails", () => {
    let state = created()
    const spawn = reduce(state, {
      t: "spawn",
      agentId: "child-1",
      parentId: "main-1",
      name: "Worker",
      task: "task",
      taskMessageId: "m1",
      now: later,
    })
    if (!spawn.ok) throw new Error(spawn.message)
    state = spawn.state
    const result = reduce(state, {
      t: "main_settled",
      outcome: { status: "error", summary: null, error: "fail" },
      now: later,
    })
    if (!result.ok) throw new Error(result.message)
    const child = result.state.agents.find((a) => a.id === "child-1")
    expect(child?.status).toBe("stopped")
  })
})

describe("reduce child settled", () => {
  test("child failure does not fail run; notifies main", () => {
    let state = created()
    // main goes idle
    const idle = reduce(state, {
      t: "main_settled",
      outcome: { status: "success", summary: null, error: null },
      now: later,
    })
    if (!idle.ok) throw new Error(idle.message)
    state = idle.state
    const spawn = reduce(state, {
      t: "spawn",
      agentId: "child-1",
      parentId: "main-1",
      name: "Worker",
      task: "find flag",
      taskMessageId: "mt",
      now: later,
    })
    if (!spawn.ok) throw new Error(spawn.message)
    state = spawn.state

    // spawn sets main still idle - but spawn requires main running|idle OK
    // After spawn main is still idle. Child settles.
    const result = reduce(state, {
      t: "child_settled",
      agentId: "child-1",
      outcome: { status: "error", summary: null, error: "child boom" },
      noticeMessageId: "notice-1",
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("running")
    const child = result.state.agents.find((a) => a.id === "child-1")
    expect(child?.status).toBe("failed")
    const main = result.state.agents.find((a) => a.id === "main-1")
    expect(main?.status).toBe("running")
    expect(result.effects.some((e) => e.t === "insert_message")).toBe(true)
    expect(result.effects.some((e) => e.t === "dispatch")).toBe(true)
  })
})

describe("reduce spawn", () => {
  test("only main can spawn", () => {
    let state = created()
    const spawn = reduce(state, {
      t: "spawn",
      agentId: "child-1",
      parentId: "main-1",
      name: "W",
      task: "t",
      taskMessageId: "m",
      now: later,
    })
    if (!spawn.ok) throw new Error(spawn.message)
    state = spawn.state
    const nested = reduce(state, {
      t: "spawn",
      agentId: "child-2",
      parentId: "child-1",
      name: "nested",
      task: "t",
      taskMessageId: "m2",
      now: later,
    })
    expect(nested.ok).toBe(false)
    if (nested.ok) return
    expect(nested.code).toBe("invalid_state")
  })
})

describe("reduce container + boot recovery", () => {
  test("container failure pauses run", () => {
    const result = reduce(created(), {
      t: "container_failed",
      error: "docker gone",
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("paused")
    expect(result.state.error).toBe("docker gone")
  })

  test("boot recovery pauses running without pending finish", () => {
    const result = reduce(created(), { t: "recover_on_boot", now: later })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("paused")
    expect(result.state.agents[0]?.status).toBe("paused")
  })

  test("boot recovery completes pending finish", () => {
    let state = created()
    const fin = reduce(state, { t: "request_finish", summary: "done" })
    if (!fin.ok) throw new Error(fin.message)
    state = fin.state
    const result = reduce(state, { t: "recover_on_boot", now: later })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe("completed")
    expect(result.state.summary).toBe("done")
  })
})

describe("reduce user_message", () => {
  test("wakes idle main", () => {
    let state = created()
    const idle = reduce(state, {
      t: "main_settled",
      outcome: { status: "success", summary: null, error: null },
      now: later,
    })
    if (!idle.ok) throw new Error(idle.message)
    state = idle.state
    const result = reduce(state, {
      t: "user_message",
      text: "try again",
      messageId: "u1",
      now: later,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.agents[0]?.status).toBe("running")
    expect(result.effects.some((e) => e.t === "dispatch")).toBe(true)
  })

  test("rejects when paused", () => {
    const paused = reduce(created(), { t: "pause", now: later })
    if (!paused.ok) throw new Error("setup")
    const result = reduce(paused.state, {
      t: "user_message",
      text: "hi",
      messageId: "u1",
      now: later,
    })
    expect(result.ok).toBe(false)
  })
})
