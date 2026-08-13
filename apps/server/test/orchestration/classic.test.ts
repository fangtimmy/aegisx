import { describe, expect, test } from "bun:test"

import classic from "../../src/orchestration/classic"
import {
  createRunHandle,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
import type { PromptContext } from "../../src/orchestration/types"

function ctxWith(opts: {
  platformIntegrated: boolean
  targetSupported: boolean
}): PromptContext {
  return {
    event: { id: "e1", name: "Ev", platform: "ctfd", promptHint: "" },
    challenge: {
      id: "c1",
      name: "Ch",
      description: "d",
      category: "web",
      points: 100,
      attachments: [],
      attachmentPaths: [],
    },
    run: {
      id: "run-1",
      environment: "container",
      isContainer: true,
      workspace: "/workspace",
      targetSupported: opts.targetSupported,
      platformIntegrated: opts.platformIntegrated,
      containerImage: "img",
      cpus: 2,
      memoryMb: 1024,
      pidsLimit: 128,
    },
  }
}

function runClassic(ctx: PromptContext): {
  created: FreshAgentInput[]
  initialPrompt: string
} {
  const created: FreshAgentInput[] = []
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    params: {},
    ctx,
    initialPrompt: "INITIAL-PROMPT",
    templateMap: new Map([
      ["mainSystem", "MAIN"],
      ["childSystem", "CHILD"],
      ["initial", "INITIAL"],
    ]),
    emitter: new RunEmitter(),
    findAgentBySlot: () => undefined,
    createFreshAgent: (input) => {
      created.push(input)
      return `a-${created.length}`
    },
    resolveAgentModel: () => ({
      provider: "P",
      providerLabel: "P",
      modelId: "m",
      modelLabel: "M",
      thinkingLevel: "off",
    }),
    isAgentStreaming: () => false,
    prepareAgent: async () => {},
    sendToAgent: async () => {},
    abortAgent: async () => {},
  }
  const handle = createRunHandle(host)
  // classic setup is challenge-scope: setup(run). Narrow the union so the
  // 1-arg call typechecks (EventPlugin.setup needs (run, event)).
  if (classic.scope !== "challenge") {
    throw new Error("classic must be challenge-scoped")
  }
  void classic.setup(handle)
  return { created, initialPrompt: "INITIAL-PROMPT" }
}

describe("classic plugin (spec §7.1, parity)", () => {
  test("declares a single entry solver, primed with run.initialPrompt", () => {
    const { created } = runClassic(
      ctxWith({ platformIntegrated: true, targetSupported: true })
    )
    expect(created).toHaveLength(1)
    const solver = created[0]!
    expect(solver.slot).toBe("solver")
    expect(solver.role).toBe("solver")
    expect(solver.isEntry).toBe(true)
    expect(solver.name).toBe("Solver")
    // prime = run.initialPrompt (the queue.prompt → initialPrompt → prime link)
    // is asserted via the service-level create test; here the spec value is the
    // initialPrompt the handle carried.
  })

  test("platform + target challenge → full tool set", () => {
    const { created } = runClassic(
      ctxWith({ platformIntegrated: true, targetSupported: true })
    )
    expect(created[0]!.tools).toEqual(
      expect.arrayContaining([
        "finish_run",
        "spawn_agent",
        "read_agent",
        "submit_flag",
        "get_target",
        "start_target",
        "extend_target",
        "stop_target",
      ])
    )
    expect(created[0]!.tools).toEqual(expect.arrayContaining(["submit_flag"]))
  })

  test("non-platform, non-target challenge → submit_flag granted, no target tools", () => {
    const { created } = runClassic(
      ctxWith({ platformIntegrated: false, targetSupported: false })
    )
    const tools = created[0]!.tools
    expect(tools).toContain("finish_run")
    expect(tools).toContain("spawn_agent")
    expect(tools).toContain("read_agent")
    // submit_flag is unconditional for solvers (spec §7.1); non-platform flags
    // record as locally accepted. Target tools stay conditional on capability.
    expect(tools).toContain("submit_flag")
    expect(tools.filter((t) => t.endsWith("_target"))).toEqual([])
  })

  test("platform without target → submit_flag but no target tools", () => {
    const { created } = runClassic(
      ctxWith({ platformIntegrated: true, targetSupported: false })
    )
    const tools = created[0]!.tools
    expect(tools).toContain("submit_flag")
    expect(tools.filter((t) => t.endsWith("_target"))).toEqual([])
  })

  test("systemPrompt uses the mainSystem template key", () => {
    const { created } = runClassic(
      ctxWith({ platformIntegrated: true, targetSupported: true })
    )
    // The fake host renders "mainSystem" → "MAIN" verbatim.
    expect(created[0]!.systemPrompt).toBe("MAIN")
  })
})
