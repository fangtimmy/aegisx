import { describe, expect, test } from "bun:test"

import {
  createRunHandle,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
import trio from "../../src/orchestration/trio"
import type { PromptContext, SlotModel } from "../../src/orchestration/types"

const baseCtx: PromptContext = {
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
    targetSupported: true,
    platformIntegrated: true,
    containerImage: "img",
    cpus: 2,
    memoryMb: 1024,
    pidsLimit: 128,
  },
}

/** Per-slot model the system injects from the orchestration settings
 * (agentModels.trio.{solver-a,b,c}) — each slot snapshots its own ref. */
const SLOT_MODELS: Record<string, SlotModel> = {
  "solver-a": {
    ref: "P/m-a:off",
    thinkingLevel: "off",
    providerLabel: "P",
    modelLabel: "M-A",
    modelId: "m-a",
  },
  "solver-b": {
    ref: "P/m-b:low",
    thinkingLevel: "low",
    providerLabel: "P",
    modelLabel: "M-B",
    modelId: "m-b",
  },
  "solver-c": {
    ref: "P/m-c:high",
    thinkingLevel: "high",
    providerLabel: "P",
    modelLabel: "M-C",
    modelId: "m-c",
  },
}

function runSetup(): {
  created: FreshAgentInput[]
  primeAgentIds: string[]
} {
  const created: FreshAgentInput[] = []
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    agents: trio.agents,
    ctx: baseCtx,
    initialPrompt: "INITIAL",
    templateMap: new Map([
      ["trioSystem", "TRIO"],
      ["childSystem", "CHILD"],
      ["initial", "INITIAL"],
    ]),
    emitter: new RunEmitter(),
    findAgentBySlot: () => undefined,
    createFreshAgent: (input) => {
      created.push(input)
      return `a-${created.length}`
    },
    resolveSlotModel: (slot) => SLOT_MODELS[slot]!,
    isAgentStreaming: () => false,
    prepareAgent: async () => {},
    sendToAgent: async () => {},
    abortAgent: async () => {},
  }
  if (trio.scope !== "challenge") {
    throw new Error("trio must be challenge-scoped")
  }
  const handle = createRunHandle(host)
  // trio has no event wiring; createRunHandle materializes its agents.
  void handle
  return { created, primeAgentIds: handle.primeSpecs.map((p) => p.agentId) }
}

describe("trio plugin (spec §7.4)", () => {
  test("declares three peer solvers; solver-a is the sole entry; all primed", () => {
    const { created, primeAgentIds } = runSetup()
    expect(created).toHaveLength(3)
    expect(created.map((a) => a.slot)).toEqual([
      "solver-a",
      "solver-b",
      "solver-c",
    ])
    expect(created.map((a) => a.name)).toEqual([
      "Solver 1",
      "Solver 2",
      "Solver 3",
    ])
    expect(created.filter((a) => a.isEntry)).toHaveLength(1)
    expect(created[0]!.isEntry).toBe(true)
    // every solver primes the run's initial prompt.
    expect(primeAgentIds).toEqual(["a-1", "a-2", "a-3"])
  })

  test("each solver snapshots its own model ref from the slot settings", () => {
    const { created } = runSetup()
    expect(created.map((a) => a.model)).toEqual([
      "P/m-a:off",
      "P/m-b:low",
      "P/m-c:high",
    ])
  })

  test("peers coordinate via message/read/list; no spawn_agent", () => {
    const { created } = runSetup()
    for (const agent of created) {
      expect(agent.tools).toEqual(
        expect.arrayContaining([
          "finish_run",
          "message_agent",
          "read_agent",
          "list_agents",
          "submit_flag",
          "get_target",
          "start_target",
          "extend_target",
          "stop_target",
        ])
      )
      expect(agent.tools).not.toContain("spawn_agent")
    }
  })
})
