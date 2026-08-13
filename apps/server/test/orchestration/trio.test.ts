import { describe, expect, test } from "bun:test"

import {
  createRunHandle,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
import trio from "../../src/orchestration/trio"
import type { PromptContext } from "../../src/orchestration/types"

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

const MODELS = [
  { provider: "P", modelId: "m-a", thinking: "off" as const },
  { provider: "P", modelId: "m-b", thinking: "low" as const },
  { provider: "P", modelId: "m-c", thinking: "high" as const },
]

function runSetup(): {
  created: FreshAgentInput[]
  primeAgentIds: string[]
} {
  const created: FreshAgentInput[] = []
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    params: { models: MODELS },
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
    resolveAgentModel: (m) =>
      m === "default"
        ? {
            provider: "P",
            providerLabel: "P",
            modelId: "m",
            modelLabel: "M",
            thinkingLevel: "off",
          }
        : {
            provider: m.provider,
            providerLabel: m.provider,
            modelId: m.modelId,
            modelLabel: null,
            thinkingLevel: m.thinking,
          },
    isAgentStreaming: () => false,
    prepareAgent: async () => {},
    sendToAgent: async () => {},
    abortAgent: async () => {},
  }
  const handle = createRunHandle(host)
  if (trio.scope !== "challenge") {
    throw new Error("trio must be challenge-scoped")
  }
  void trio.setup(handle)
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

  test("each solver snapshots its own model from params.models", () => {
    const { created } = runSetup()
    expect(created.map((a) => a.model.modelId)).toEqual(["m-a", "m-b", "m-c"])
    expect(created.map((a) => a.model.thinkingLevel)).toEqual([
      "off",
      "low",
      "high",
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
