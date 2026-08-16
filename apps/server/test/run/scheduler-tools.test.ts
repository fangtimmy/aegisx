import { describe, expect, mock, test } from "bun:test"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { eq } from "drizzle-orm"

import { agents, runQueue, sessionEntries, sessions } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  TEST_MODEL_REF,
  now,
} from "../helpers"

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

type Db = ReturnType<typeof setupDb>["db"]

/** Service whose createHost stub records the orchestrator's granted tools
 * (the createHost call carrying scheduler tools) + per-agent prompt texts. */
function makeService(
  db: Db,
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string,
  opts: { hang?: boolean } = {}
) {
  const hang = opts.hang ?? true
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  const orchestratorTools: ToolDefinition[] = []
  const promptLog = new Map<string, string[]>()
  const service = createRunService({
    db,
    sqlite,
    dataDir: dir,
    containerManager: manager,
    platformService: {
      submitFlag: async () => undefined,
      targetAction: async () => ({
        status: "running",
        endpoints: [],
        expiresAt: null,
      }),
    } as never,
    configStore: stubConfigStore([provider]),
    getSettings: flatSettingsWithDefaultModel,
    createHost: mock(
      async (input: { agentId: string; extraTools?: ToolDefinition[] }) => {
        if (input.extraTools?.some((t) => t.name === "enqueue_run")) {
          orchestratorTools.push(...input.extraTools)
        }
        const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang,
        })
        const list: string[] = []
        promptLog.set(input.agentId, list)
        const sdk = stub.session as unknown as {
          prompt: (text: string) => Promise<void>
        }
        sdk.prompt = async (text: string) => {
          list.push(text)
          if (hang) await new Promise(() => {})
        }
        return stub
      }
    ),
  })
  return { service, orchestratorTools, promptLog }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

const findTool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

const invoke = (tool: ToolDefinition, params: object) =>
  Promise.resolve(
    tool.execute(
      "id",
      params as never,
      undefined,
      undefined,
      undefined as never
    )
  )

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  (result.content[0] as { text: string }).text

/** Start the event's scheduler run so its tool context goes live, and return
 * the granted scheduler tools. */
async function schedulerToolsOf(
  service: ReturnType<typeof makeService>["service"],
  tools: ToolDefinition[]
) {
  await service.startScheduler("evt-1")
  if (!tools.length) throw new Error("scheduler tools were not granted")
  return tools
}

let entryCounter = 0

/** Insert one session_entries row with an arbitrary message JSON. */
function insertEntry(
  db: Db,
  runId: string,
  agentId: string,
  sessionId: string,
  seq: number,
  message: Record<string, unknown>
) {
  entryCounter += 1
  db.insert(sessionEntries)
    .values({
      id: `entry-${entryCounter}`,
      sessionId,
      agentId,
      runId,
      seq,
      type: "message",
      data: JSON.stringify({
        type: "message",
        id: `m-${entryCounter}`,
        parentId: null,
        timestamp: new Date(Date.parse(now()) + seq * 1000).toISOString(),
        message,
      }),
      createdAt: now(),
    })
    .run()
}

describe("scheduler tools (v9: launch specs, agent addressing)", () => {
  test("enqueue_run lands the v9 launch specs in the queue (params + prompt)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service, orchestratorTools } = makeService(db, sqlite, dir)
      const tools = await schedulerToolsOf(service, orchestratorTools)
      service.queue().cancelDrain()

      await invoke(findTool(tools, "enqueue_run"), {
        challenge_id: "ch-1",
        strategy: "focus the heap",
        model: TEST_MODEL_REF,
        solver_count: 2,
        timeout_ms: 120_000,
      })
      const row = db.select().from(runQueue).get()!
      expect(row.prompt).toBe("focus the heap")
      expect(JSON.parse(row.params)).toEqual({
        strategy: "focus the heap",
        model: TEST_MODEL_REF,
        solverCount: 2,
      })
      expect(row.timeoutMs).toBe(120_000)
      await service.close()
    } finally {
      close()
    }
  })

  test("a hallucinated model ref is rejected with the available model list", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service, orchestratorTools } = makeService(db, sqlite, dir)
      const tools = await schedulerToolsOf(service, orchestratorTools)
      service.queue().cancelDrain()

      const bad = `nope/hallucinated:${"off"}`
      await expect(
        invoke(findTool(tools, "enqueue_run"), {
          challenge_id: "ch-1",
          model: bad,
        })
      ).rejects.toThrow(new RegExp(`Available models: .*${TEST_MODEL_REF}`))
      await expect(
        invoke(findTool(tools, "start_run"), {
          challenge_id: "ch-1",
          model: bad,
        })
      ).rejects.toThrow(/Available models:/)
      // Solver-level refs are checked too; nothing was enqueued.
      await expect(
        invoke(findTool(tools, "enqueue_run"), {
          challenge_id: "ch-1",
          solvers: [{ model: bad }],
        })
      ).rejects.toThrow(/Available models:/)
      expect(db.select().from(runQueue).all()).toHaveLength(0)
      await service.close()
    } finally {
      close()
    }
  })

  test("start_run shapes the run from the specs (solvers win over model/solver_count)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service, orchestratorTools } = makeService(db, sqlite, dir)
      const tools = await schedulerToolsOf(service, orchestratorTools)

      const result = await invoke(findTool(tools, "start_run"), {
        challenge_id: "ch-1",
        strategy: "run strat",
        model: `${TEST_MODEL_REF}:high`,
        solver_count: 3,
        solvers: [
          { model: `${TEST_MODEL_REF}:off` },
          { prompt: "angle b", prompt_mode: "override" },
        ],
      })
      const runId = (result.details as { id: string }).id
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, runId))
        .orderBy(agents.slot)
        .all()
      // solvers overrode model/solver_count: exactly 2, first carries the
      // explicit model, second falls back to the global default.
      expect(rows.map((a) => a.slot)).toEqual(["solver-1", "solver-2"])
      expect(rows.map((a) => a.model)).toEqual([
        `${TEST_MODEL_REF}:off`,
        `${TEST_MODEL_REF}:off`,
      ])
      await service.close()
    } finally {
      close()
    }
  })

  test("read_run agent level: status header + the target agent's recent messages", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, { id: "run-1", status: "idle", challengeId: "ch-1" })
      db.insert(agents)
        .values([
          {
            id: "a-1",
            runId: "run-1",
            slot: "solver-1",
            role: "solver",
            isEntry: true,
            model: `${TEST_MODEL_REF}:off`,
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-a",
            name: "Solver 1",
            createdAt: now(),
            updatedAt: now(),
          },
          {
            id: "a-2",
            runId: "run-1",
            slot: "solver-2",
            role: "solver",
            isEntry: false,
            model: `${TEST_MODEL_REF}:low`,
            systemPrompt: "sp",
            tools: "[]",
            status: "idle",
            sessionFile: "sess-b",
            name: "Solver 2",
            createdAt: now(),
            updatedAt: now(),
          },
        ])
        .run()
      db.insert(sessions)
        .values([
          { id: "sess-a", agentId: "a-1", cwd: "/workspace", createdAt: now() },
          { id: "sess-b", agentId: "a-2", cwd: "/workspace", createdAt: now() },
        ])
        .run()
      insertEntry(db, "run-1", "a-1", "sess-a", 1, {
        role: "user",
        content: [{ type: "text", text: "entry agent message" }],
      })
      insertEntry(db, "run-1", "a-2", "sess-b", 1, {
        role: "user",
        content: "u1",
      })
      insertEntry(db, "run-1", "a-2", "sess-b", 2, {
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
      })
      insertEntry(db, "run-1", "a-2", "sess-b", 3, {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text", text: "first output line\nsecond line" }],
        isError: true,
      })
      insertEntry(db, "run-1", "a-2", "sess-b", 4, {
        role: "assistant",
        content: [{ type: "text", text: "final answer body" }],
      })

      const { service, orchestratorTools } = makeService(db, sqlite, dir, {
        hang: false,
      })
      const tools = await schedulerToolsOf(service, orchestratorTools)

      const out = JSON.parse(
        textOf(
          await invoke(findTool(tools, "read_run"), {
            run_id: "run-1",
            agent_id: "a-2",
            last_n: 2,
          })
        )
      )
      // Status header: the target agent (not the entry default).
      expect(out.agent).toEqual({
        id: "a-2",
        slot: "solver-2",
        name: "Solver 2",
        status: "idle",
        model: `${TEST_MODEL_REF}:low`,
      })
      expect(out.run.status).toBe("idle")
      expect(typeof out.elapsed).toBe("string")
      expect(out.deadlineRemaining).toBeNull()
      // The last 2 renderable messages of a-2 only (tool one-liner + text).
      expect(out.messages).toEqual([
        "[tool bash] first output line (error)",
        "[assistant] final answer body",
      ])
      expect(out.lastMessageAt).toBe(
        new Date(Date.parse(now()) + 4_000).toISOString()
      )
      expect(out.agents.map((a: { id: string }) => a.id).sort()).toEqual([
        "a-1",
        "a-2",
      ])

      // Default (no agent_id) reads the entry agent.
      const entryOut = JSON.parse(
        textOf(await invoke(findTool(tools, "read_run"), { run_id: "run-1" }))
      )
      expect(entryOut.agent.id).toBe("a-1")
      expect(entryOut.messages).toEqual(["[user] entry agent message"])
      await settle()
      await service.close()
    } finally {
      close()
    }
  })

  test("add_agent / message_agent tools address agents directly", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service, orchestratorTools, promptLog } = makeService(
        db,
        sqlite,
        dir,
        { hang: false }
      )
      const tools = await schedulerToolsOf(service, orchestratorTools)

      const run = await service.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()

      const added = await invoke(findTool(tools, "add_agent"), {
        run_id: run.id,
        prompt: "extra angle via tool",
      })
      expect((added.details as { id: string }).id).toBe(run.id)
      const after = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .orderBy(agents.slot)
        .all()
      expect(after.map((a) => a.slot)).toEqual(["solver-1", "solver-2"])

      await settle()
      const target = after[1]!
      const before = (promptLog.get(target.id) ?? []).length
      await invoke(findTool(tools, "message_agent"), {
        agent_id: target.id,
        text: "status report please",
      })
      expect((promptLog.get(target.id) ?? []).length).toBe(before + 1)
      expect(promptLog.get(target.id)!.at(-1)).toBe("status report please")
      await settle()
      await service.close()
    } finally {
      close()
    }
  })
})
