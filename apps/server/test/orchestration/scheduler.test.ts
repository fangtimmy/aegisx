import { describe, expect, test } from "bun:test"

import {
  createRunHandle,
  EventScopeEmitter,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
import scheduler from "../../src/orchestration/scheduler"
import type { PromptContext } from "../../src/orchestration/types"

const eventCtx: PromptContext = {
  event: { id: "e1", name: "Ev", platform: "ctfd", promptHint: "" },
  model: { provider: "P", name: "M", id: "m" },
  run: {
    id: "run-1",
    environment: "container",
    isContainer: true,
    workspace: "/workspace",
    targetSupported: false,
    platformIntegrated: false,
    containerImage: "img",
    cpus: 2,
    memoryMb: 1024,
    pidsLimit: 128,
  },
  instruction: "Hit crypto first.",
}

function runSetup(): {
  created: FreshAgentInput[]
  sends: Array<{ agentId: string; text: string }>
  event: EventScopeEmitter
} {
  const created: FreshAgentInput[] = []
  const sends: Array<{ agentId: string; text: string }> = []
  const event = new EventScopeEmitter()
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "event",
    params: { model: { provider: "P", modelId: "m", thinking: "off" } },
    ctx: eventCtx,
    initialPrompt: "SCHED-INIT",
    templateMap: new Map([
      ["orchestratorSystem", "ORCH"],
      ["initial", "SCHED-INIT"],
      ["childSystem", "CHILD"],
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
    sendToAgent: async (agentId, text) => {
      sends.push({ agentId, text })
    },
    abortAgent: async () => {},
  }
  const handle = createRunHandle(host)
  if (scheduler.scope !== "event") {
    throw new Error("scheduler must be event-scoped")
  }
  void scheduler.setup(handle, event)
  return { created, sends, event }
}

describe("scheduler plugin (spec §7.5)", () => {
  test("declares one entry orchestrator, primed with the event-scope initial prompt", () => {
    const { created } = runSetup()
    expect(created).toHaveLength(1)
    const orch = created[0]!
    expect(orch.slot).toBe("orchestrator")
    expect(orch.role).toBe("orchestrator")
    expect(orch.name).toBe("Scheduler")
    expect(orch.isEntry).toBe(true)
    expect(orch.tools).toEqual(["list_agents"])
  })

  test("wakes the orchestrator on run lifecycle events", () => {
    const { sends, event } = runSetup()
    event.emit({ type: "run.idle", runId: "r-100" })
    event.emit({ type: "run.flagAccepted", runId: "r-100" })
    event.emit({ type: "run.timedOut", runId: "r-100", outcome: "closed" })
    expect(sends.map((s) => s.agentId)).toEqual(["a-1", "a-1", "a-1"])
    expect(sends[0]!.text).toContain("r-100")
    expect(sends[0]!.text).toContain("idle")
    expect(sends[1]!.text).toContain("flag")
    expect(sends[2]!.text).toContain("closed")
  })
})
