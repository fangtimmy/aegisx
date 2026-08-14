import { describe, expect, test } from "bun:test"

import bootstrapSolver from "../../src/orchestration/bootstrap-solver"
import {
  createRunHandle,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
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

function runSetup(): {
  created: FreshAgentInput[]
  sends: Array<{ agentId: string; text: string }>
  emitter: RunEmitter
} {
  const created: FreshAgentInput[] = []
  const sends: Array<{ agentId: string; text: string }> = []
  const emitter = new RunEmitter()
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    agents: bootstrapSolver.agents,
    ctx: baseCtx,
    initialPrompt: "INITIAL",
    templateMap: new Map([
      // Bootstrap template advertises its caps so the derived-zeroing is
      // observable in the rendered system prompt.
      [
        "bootstrapSystem",
        "BOOT {{agent.name}} finish={{capabilities.canFinish}} submit={{capabilities.canSubmitFlag}}",
      ],
      ["mainSystem", "MAIN"],
      ["childSystem", "CHILD"],
      ["initial", "INITIAL"],
    ]),
    emitter,
    findAgentBySlot: () => undefined,
    createFreshAgent: (input) => {
      created.push(input)
      return `a-${created.length}`
    },
    resolveSlotModel: () => ({
      ref: "P/m:off",
      thinkingLevel: "off",
      providerLabel: "P",
      modelLabel: "M",
      modelId: "m",
    }),
    isAgentStreaming: () => false,
    prepareAgent: async () => {},
    sendToAgent: async (agentId, text) => {
      sends.push({ agentId, text })
    },
    abortAgent: async () => {},
  }
  const handle = createRunHandle(host)
  if (bootstrapSolver.scope !== "challenge") {
    throw new Error("bootstrap-solver must be challenge-scoped")
  }
  void bootstrapSolver.wire?.(handle)
  return { created, sends, emitter }
}

describe("bootstrap-solver plugin (spec §7.3)", () => {
  test("declares primed bootstrap (no finish_run) + entry solver (full tools)", () => {
    const { created } = runSetup()
    expect(created).toHaveLength(2)

    const bootstrap = created[0]!
    expect(bootstrap.slot).toBe("bootstrap")
    expect(bootstrap.isEntry).toBe(false)
    expect(bootstrap.tools).toEqual(
      expect.arrayContaining([
        "submit_flag",
        "get_target",
        "start_target",
        "extend_target",
        "stop_target",
      ])
    )
    expect(bootstrap.tools).not.toContain("finish_run")
    expect(bootstrap.tools).not.toContain("spawn_agent")

    const solver = created[1]!
    expect(solver.slot).toBe("solver")
    expect(solver.isEntry).toBe(true)
    expect(solver.tools).toContain("finish_run")
    expect(solver.tools).toContain("spawn_agent")
  })

  test("bootstrap renders canFinish=false (no finish_run in its tools)", () => {
    const { created } = runSetup()
    expect(created[0]!.systemPrompt).toBe(
      "BOOT Bootstrap finish=false submit=true"
    )
  })

  test("bootstrap turn end drives the solver", () => {
    const { sends, emitter } = runSetup()
    emitter.emit("a-1", { type: "turnEnded" })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.agentId).toBe("a-2")
    expect(sends[0]!.text).toContain("/workspace")
  })
})
