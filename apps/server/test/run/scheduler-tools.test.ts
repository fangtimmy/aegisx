import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, runQueue } from "../../src/db/schema"
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

/** Service with a stubbed container + host session (no real Docker / LLM).
 * `grantedTools` (when passed) collects the native tool names handed to
 * createHost — used to assert what an agent is actually granted. */
function makeService(
  db: Db,
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string,
  opts: { hang?: boolean; grantedTools?: string[] } = {}
) {
  const hang = opts.hang ?? true
  const provider = makeProvider()
  const { manager, created } = stubContainerManager()
  const grantedTools = opts.grantedTools
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
      async (input: {
        agentId: string
        extraTools?: Array<{ name: string }>
      }) => {
        if (grantedTools) {
          grantedTools.push(...(input.extraTools ?? []).map((t) => t.name))
        }
        const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang,
        })
        const sdk = stub.session as unknown as {
          prompt: (text: string) => Promise<void>
        }
        sdk.prompt = async (text: string) => {
          if (hang) await new Promise(() => {})
        }
        return stub
      }
    ),
  })
  return { service, created }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

/**
 * Scheduler service behaviors the `aegisx` SDK maps to (scheduler-python-sdk.md).
 * The 18 native management tools are unmounted (ORCHESTRATOR_TOOLS = []) —
 * the SDK drives these service paths over HTTP, so the coverage lives here.
 */
describe("scheduler service behaviors (SDK backend)", () => {
  test("event-scope orchestrator gets NO management tools (SDK replaces them)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { service } = makeService(db, sqlite, dir)

      const run = await service.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })

      expect(run.scopeType).toBe("event")
      const rows = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.slot).toBe("orchestrator")
      expect(rows[0]!.role).toBe("orchestrator")
      expect(rows[0]!.isEntry).toBe(true)
      // SDK convergence: the snapshot grants no management tools; the
      // orchestrator manages via `aegisx` + the four file/bash tools.
      expect(JSON.parse(rows[0]!.tools)).toEqual([])
      await service.close()
    } finally {
      close()
    }
  })

  test("cold restore of a legacy orchestrator grants NO management tools", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedRun(db, {
        id: "legacy-sched",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        status: "closed",
      })
      db.insert(agents)
        .values({
          id: "legacy-orch",
          runId: "legacy-sched",
          slot: "orchestrator",
          role: "orchestrator",
          isEntry: true,
          model: `${TEST_MODEL_REF}:off`,
          systemPrompt: "sp",
          // Pre-SDK snapshot: the old 18 management tool names.
          tools: JSON.stringify([
            "enqueue_run",
            "list_queue",
            "remove_queue",
            "clear_queue",
            "reorder_queue",
            "start_run",
            "stop_run",
            "message_run",
            "close_run",
            "read_run",
            "set_run_timeout",
            "list_challenges",
            "get_challenge",
            "list_runs",
            "get_status",
            "list_agents",
            "add_agent",
            "message_agent",
          ]),
          status: "idle",
          sessionFile: "sess-legacy",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const granted: string[] = []
      const { service } = makeService(db, sqlite, dir, {
        hang: false,
        grantedTools: granted,
      })
      await service.sendMessage("legacy-sched", { text: "wake up" })
      await settle()
      // SDK convergence: the legacy snapshot is intersected with the (now
      // empty) ORCHESTRATOR_TOOLS — no management tool is resurrected. The
      // four file tools are host-side always-on, not part of this grant.
      expect(granted).toEqual([])
      await service.close()
    } finally {
      close()
    }
  })

  test("event container gets SDK + /runs mounts; solver gets SDK-only (no /runs)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, {
        id: "sched-1",
        scopeType: "event",
        eventId: "evt-1",
        challengeId: null,
        status: "closed",
      })
      db.insert(agents)
        .values({
          id: "orch-1",
          runId: "sched-1",
          slot: "orchestrator",
          role: "orchestrator",
          isEntry: true,
          model: `${TEST_MODEL_REF}:off`,
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          sessionFile: "sess-orch-1",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      seedRun(db, {
        id: "solver-1",
        scopeType: "challenge",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "closed",
      })
      db.insert(agents)
        .values({
          id: "sol-a1",
          runId: "solver-1",
          slot: "solver-1",
          role: "solver",
          isEntry: true,
          model: `${TEST_MODEL_REF}:off`,
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          sessionFile: "sess-sol-1",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const { service, created } = makeService(db, sqlite, dir, {
        hang: false,
      })
      await service.sendMessage("sched-1", { text: "wake" })
      await settle()
      await service.sendMessage("solver-1", { text: "wake" })
      await settle()

      expect(created.length).toBe(2)
      const [schedOpts, solverOpts] = created as Array<{
        extraBinds?: string[]
        env?: string[]
      }>
      // The scheduler container: read-only SDK mount + read-only run
      // workspaces (so it reads WRITEUP.md / solve.sh directly) + event env.
      expect(schedOpts.extraBinds).toContain(`${dir}/runs:/runs:ro`)
      expect(
        schedOpts.extraBinds?.some((b) => b.includes("/opt/aegisx-sdk:ro"))
      ).toBe(true)
      expect(schedOpts.env).toContain("AEGISX_EVENT_ID=evt-1")
      expect(schedOpts.env).toContain("PYTHONPATH=/opt/aegisx-sdk")
      // The solver container (channels era, docs/im-channels.md §4): the
      // same read-only SDK mount + event/API env with AEGISX_ROLE=solver, but
      // NO /runs mount (a solver never sees other runs' workspaces).
      expect(solverOpts.extraBinds).toEqual(
        schedOpts.extraBinds?.filter((b) => b.includes("/opt/aegisx-sdk:ro"))
      )
      expect(solverOpts.extraBinds?.some((b) => b.includes("/runs:ro"))).toBe(
        false
      )
      expect(solverOpts.env).toContain("AEGISX_EVENT_ID=evt-1")
      expect(solverOpts.env).toContain("PYTHONPATH=/opt/aegisx-sdk")
      expect(solverOpts.env).toContain("AEGISX_ROLE=solver")
      await service.close()
    } finally {
      close()
    }
  })

  test("enqueue rejects a hallucinated model ref with the available list", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service } = makeService(db, sqlite, dir)
      service.queue().cancelDrain()

      const bad = `nope/hallucinated:off`
      // Run-level ref (the HTTP enqueue / runs.start fail-fast path).
      expect(() => service.assertModelsResolvable(bad, undefined)).toThrow(
        new RegExp(`Available models: .*${TEST_MODEL_REF}`)
      )
      // Solver-level refs are checked too.
      expect(() =>
        service.assertModelsResolvable(undefined, [{ model: bad }])
      ).toThrow(/Available models:/)
      expect(db.select().from(runQueue).all()).toHaveLength(0)
      await service.close()
    } finally {
      close()
    }
  })
})
