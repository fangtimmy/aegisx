import { describe, expect, test } from "bun:test"

import type { agents } from "../../src/db/schema"
import {
  createRunHandle,
  RunEmitter,
  type FreshAgentInput,
  type RunHandleHost,
} from "../../src/orchestration/run-handle"
import type { PromptContext } from "../../src/orchestration/types"

type AgentRow = typeof agents.$inferSelect

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
  capabilities: {
    canFinish: true,
    canSubmitFlag: true,
    canManageTarget: true,
    canSpawn: true,
  },
}

function fakeHost(opts: {
  ctx?: PromptContext
  initialPrompt?: string
  templateMap?: Map<string, string>
  existing?: Record<string, { id: string; role: string }>
}): { host: RunHandleHost; created: FreshAgentInput[] } {
  const created: FreshAgentInput[] = []
  const existing = new Map(Object.entries(opts.existing ?? {}))
  const host: RunHandleHost = {
    runId: "run-1",
    scope: "challenge",
    params: {},
    ctx: opts.ctx ?? baseCtx,
    initialPrompt: opts.initialPrompt ?? "GO",
    templateMap:
      opts.templateMap ??
      new Map([
        [
          "mainSystem",
          "PROMPT {{agent.name}} flag={{capabilities.canSubmitFlag}} finish={{capabilities.canFinish}}",
        ],
      ]),
    emitter: new RunEmitter(),
    findAgentBySlot: (slot) => existing.get(slot) as AgentRow | undefined,
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
  return { host, created }
}

describe("createRunHandle / createAgent (spec §3.2/§4.3)", () => {
  test("fresh: persists snapshot, renders systemPrompt with per-agent caps, tracks prime", () => {
    const { host, created } = fakeHost({})
    const handle = createRunHandle(host)
    handle.createAgent({
      slot: "solver",
      name: "Solver",
      entry: true,
      systemPrompt: "mainSystem",
      tools: ["finish_run", "submit_flag"],
      model: "default",
      prime: "GO",
    })

    expect(created).toHaveLength(1)
    const agent = created[0]!
    expect(agent.slot).toBe("solver")
    expect(agent.role).toBe("solver")
    expect(agent.isEntry).toBe(true)
    expect(agent.tools).toEqual(["finish_run", "submit_flag"])
    // capabilities derived from the tool list injected into the render.
    expect(agent.systemPrompt).toBe("PROMPT Solver flag=true finish=true")
    expect(handle.primeSpecs).toEqual([
      { agentId: "a-1", slot: "solver", prime: "GO" },
    ])
  })

  test("fresh: caps derived from tools, not from run-level ctx", () => {
    // Run-level ctx advertises canSubmitFlag=true, but this agent has no
    // submit_flag tool → rendered prompt must show flag=false.
    const { host, created } = fakeHost({})
    const handle = createRunHandle(host)
    handle.createAgent({
      slot: "probe",
      name: "Probe",
      systemPrompt: "mainSystem",
      tools: ["finish_run"], // no submit_flag
      model: "default",
    })
    expect(created[0]!.systemPrompt).toBe("PROMPT Probe flag=false finish=true")
  })

  test("restore: reuses existing row (snapshot priority), does NOT re-persist", () => {
    const { host, created } = fakeHost({
      existing: { solver: { id: "existing-1", role: "solver" } },
    })
    const handle = createRunHandle(host)
    const agent = handle.createAgent({
      slot: "solver",
      name: "Solver",
      entry: true,
      systemPrompt: "mainSystem", // ignored on restore
      tools: ["finish_run"], // ignored on restore
      model: "default",
      prime: "GO",
    })
    // No fresh insert happened.
    expect(created).toHaveLength(0)
    // The existing id/role are reused.
    expect(agent.id).toBe("existing-1")
    expect(agent.role).toBe("solver")
    // prime is still collected; the SERVICE ignores it on restore (verified by
    // the lifecycle cold-restore test not re-driving).
    expect(handle.primeSpecs.map((p) => p.agentId)).toContain("existing-1")
  })

  test("agent(slot) / agents return declared handles; unknown slot throws", () => {
    const { host } = fakeHost({})
    const handle = createRunHandle(host)
    handle.createAgent({
      slot: "solver",
      name: "S",
      systemPrompt: "mainSystem",
      tools: [],
      model: "default",
    })
    expect(handle.agent("solver").slot).toBe("solver")
    expect(handle.agents).toHaveLength(1)
    expect(() => handle.agent("nope")).toThrow(
      "No agent declared for slot: nope"
    )
  })

  test("render: resolves against the in-memory map with extraVars overlay", () => {
    const map = new Map([["greet", "Hi {{agent.name}} on {{run.id}}"]])
    const { host } = fakeHost({ templateMap: map })
    const handle = createRunHandle(host)
    expect(
      handle.render("greet", {
        agent: { role: "x", isMain: true, name: "Bot", task: null },
      })
    ).toBe("Hi Bot on run-1")
    expect(() => handle.render("missing")).toThrow(
      "Prompt template not found: missing"
    )
  })

  test("on(): run-level + agent-level filtering, callbacks wrapped in try/catch", () => {
    const { host } = fakeHost({})
    const handle = createRunHandle(host)
    const runSeen: string[] = []
    const agentSeen: string[] = []
    handle.on("turnEnded", () => {
      runSeen.push("run")
    })
    const solver = handle.createAgent({
      slot: "solver",
      name: "S",
      systemPrompt: "mainSystem",
      tools: [],
      model: "default",
    })
    solver.on("turnEnded", () => {
      agentSeen.push("agent")
    })
    // A throwing callback must not abort dispatch to the others.
    handle.on("turnEnded", () => {
      throw new Error("boom")
    })
    // emit goes to run-level + the solver's agent-level subscribers.
    expect(() => host.emitter.emit("a-1", { type: "turnEnded" })).not.toThrow()
    expect(runSeen).toEqual(["run"])
    expect(agentSeen).toEqual(["agent"])
    // A non-matching agent id gets run-level only.
    host.emitter.emit("other", { type: "turnEnded" })
    expect(runSeen).toEqual(["run", "run"])
    expect(agentSeen).toEqual(["agent"])
  })
})
