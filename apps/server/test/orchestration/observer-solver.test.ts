import { describe, expect, test } from "bun:test"

import observerSolver from "../../src/orchestration/observer-solver"
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

/** Observer slot's configured model ref (agentModels.observer-solver.observer),
 * distinct from the run default so the snapshot is observable. */
const OBSERVER_MODEL_REF = "P2/obs-1:low"

function runSetup(): {
  created: FreshAgentInput[]
  sends: Array<{ agentId: string; text: string }>
  emitter: RunEmitter
  solverId: string
} {
  const created: FreshAgentInput[] = []
  const sends: Array<{ agentId: string; text: string }> = []
  const emitter = new RunEmitter()
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    agents: observerSolver.agents,
    ctx: baseCtx,
    initialPrompt: "INITIAL",
    templateMap: new Map([
      // Observer template advertises its caps so the derived-zeroing is
      // observable in the rendered system prompt.
      [
        "observerSystem",
        "OBS {{agent.name}} finish={{capabilities.canFinish}} spawn={{capabilities.canSpawn}}",
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
    resolveSlotModel: (slot) =>
      slot === "observer"
        ? {
            ref: OBSERVER_MODEL_REF,
            thinkingLevel: "low",
            providerLabel: "P2",
            modelLabel: "Obs",
            modelId: "obs-1",
          }
        : {
            ref: "P/m:off",
            thinkingLevel: "off",
            providerLabel: "P",
            modelLabel: "M",
            modelId: "m",
          },
    isAgentStreaming: () => false,
    prepareAgent: async () => {},
    sendToAgent: async (agentId, text) => {
      sends.push({ agentId, text })
    },
    abortAgent: async () => {},
  }
  const handle = createRunHandle(host)
  if (observerSolver.scope !== "challenge") {
    throw new Error("observer-solver must be challenge-scoped")
  }
  void observerSolver.wire?.(handle)
  return { created, sends, emitter, solverId: "a-1" }
}

describe("observer-solver plugin (spec §7.2)", () => {
  test("declares entry solver (primed, full tools) + observer (peer tools, own model)", () => {
    const { created } = runSetup()
    expect(created).toHaveLength(2)

    const solver = created[0]!
    expect(solver.slot).toBe("solver")
    expect(solver.isEntry).toBe(true)
    expect(solver.name).toBe("Solver")
    expect(solver.tools).toEqual(
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
    expect(solver.tools).not.toContain("message_agent")

    const observer = created[1]!
    expect(observer.slot).toBe("observer")
    expect(observer.isEntry).toBe(false)
    expect(observer.tools).toEqual([
      "message_agent",
      "read_agent",
      "list_agents",
    ])
    // Observer model comes from the observer slot setting, not the run default.
    expect(observer.model).toBe(OBSERVER_MODEL_REF)
  })

  test("observer has no finish/spawn capability — rendered prompt advertises zeroed caps", () => {
    const { created } = runSetup()
    const observer = created[1]!
    expect(observer.systemPrompt).toBe("OBS Observer finish=false spawn=false")
  })

  test("solver turn end wakes the observer (read_agent + message_agent steer)", () => {
    const { sends, emitter, solverId } = runSetup()
    emitter.emit(solverId, { type: "turnEnded" })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.agentId).toMatch(/^a-2$/)
    expect(sends[0]!.text).toContain("read_agent")
    expect(sends[0]!.text).toContain("message_agent")
  })

  test("solver flag accepted wakes the observer to double-check", () => {
    const { sends, emitter, solverId } = runSetup()
    emitter.emit(solverId, {
      type: "flagAccepted",
      flag: "flag{x}",
      status: "accepted",
    })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.agentId).toMatch(/^a-2$/)
    expect(sends[0]!.text).toContain("flag")
  })
})
