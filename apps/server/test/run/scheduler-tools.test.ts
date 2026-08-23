import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  TEST_MODEL_REF,
  now,
} from "../helpers"
import { refine } from "../support"

type Db = ReturnType<typeof setupDb>["db"]

/** Service with a stubbed container + host session (no real Docker / LLM).
 * `grantedTools` (when passed) collects the native tool names handed to
 * createHost — used to assert what an agent is actually granted. */
function makeService(
  db: Db,
  dir: string,
  opts: { hang?: boolean; grantedTools?: string[] } = {}
) {
  const hang = opts.hang ?? true
  const provider = makeProvider()
  const { manager, created } = stubContainerManager()
  const grantedTools = opts.grantedTools
  const service = createAgentService({
    db,
    dataDir: dir,
    containerManager: manager,
    platformService: refine({
      submitFlag: async () => undefined,
      targetAction: async () => ({
        status: "running",
        endpoints: [],
        expiresAt: null,
      }),
    }),
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
        const sdk = refine<{
          prompt: (text: string) => Promise<void>
        }>(stub.session)
        sdk.prompt = async () => {
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
 * Scheduler service behaviors the `aegisx` SDK maps to. The orchestrator's
 * native management tool set is EMPTY (ORCHESTRATOR_TOOLS = []) — the SDK
 * drives these service paths over HTTP, so the coverage lives here.
 */
describe("scheduler service behaviors (SDK backend)", () => {
  test("the orchestrator agent gets NO management tools (SDK replaces them)", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const { service } = makeService(db, dir)

      const sched = await service.startScheduler("evt-1")

      expect(sched.role).toBe("orchestrator")
      const row = db.select().from(agents).where(eq(agents.id, sched.id)).get()!
      // SDK convergence: the snapshot grants no management tools; the
      // orchestrator manages via `aegisx` + the four file/bash tools.
      expect(JSON.parse(row.tools)).toEqual([])
      await service.close()
    } finally {
      close()
    }
  })

  test("reopening a legacy orchestrator grants NO management tools", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      // Pre-SDK snapshot: the old 18 management tool names.
      seedAgent(db, {
        id: "legacy-orch",
        eventId: "evt-1",
        challengeId: null,
        role: "orchestrator",
        status: "completed",
        sessionFile: "sess-legacy",
        model: `${TEST_MODEL_REF}:off`,
        systemPrompt: "sp",
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
        name: "Scheduler",
        createdAt: now(),
        updatedAt: now(),
      })

      const granted: string[] = []
      const { service } = makeService(db, dir, {
        hang: false,
        grantedTools: granted,
      })
      await service.sendMessage("legacy-orch", { text: "wake up" })
      await settle()
      // SDK convergence: the legacy snapshot is intersected with the (now
      // empty) ORCHESTRATOR_TOOLS — no management tool is resurrected.
      expect(granted).toEqual([])
      await service.close()
    } finally {
      close()
    }
  })

  test("containers default to the image SDK: event env, no bind mount, no ROLE", async () => {
    const { db, dir, close } = setupDb()
    try {
      delete process.env.AEGISX_SDK_PATH
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Seed a terminal orchestrator agent so the first wake builds its
      // container; the solver is spawned fresh below.
      seedAgent(db, {
        id: "orch-1",
        eventId: "evt-1",
        challengeId: null,
        role: "orchestrator",
        status: "completed",
        sessionFile: "sess-orch-1",
        model: `${TEST_MODEL_REF}:off`,
        systemPrompt: "sp",
        name: "Scheduler",
        createdAt: now(),
        updatedAt: now(),
      })

      const { service, created } = makeService(db, dir, { hang: false })
      await service.sendMessage("orch-1", { text: "wake" })
      await settle()
      // A fresh solver spawn builds the challenge container.
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await settle()

      expect(created.length).toBe(2)
      const [schedOpts, solverOpts] = refine<
        Array<{
          extraBinds?: string[]
          env?: string[]
        }>
      >(created)
      // The scheduler container: the read-only challenge-workspaces mount
      // (WRITEUP.md / solve.sh live reads) + event env. The SDK itself ships
      // in the image — no bind mount, no PYTHONPATH override.
      expect(
        schedOpts.extraBinds?.some(
          (b) =>
            b.endsWith("/challenges:ro") &&
            b.includes(`${dir}/events/evt-1/challenges`)
        )
      ).toBe(true)
      expect(
        schedOpts.extraBinds?.some((b) => b.includes("/opt/aegisx-sdk:ro"))
      ).toBe(false)
      expect(schedOpts.env).toContain("AEGISX_EVENT_ID=evt-1")
      expect(schedOpts.env?.some((e) => e.startsWith("PYTHONPATH="))).toBe(
        false
      )
      expect(schedOpts.env).toContain(
        "AEGISX_API_URL=http://host.docker.internal:3000"
      )
      // The solver container: same event env, NO /challenges mount (a solver
      // reaches its OWN challenge at /workspace, never others).
      expect(
        solverOpts.extraBinds?.some((b) => b.includes("/challenges:ro"))
      ).toBe(false)
      expect(solverOpts.env).toContain("AEGISX_EVENT_ID=evt-1")
      await service.close()
    } finally {
      close()
    }
  })

  test("AEGISX_SDK_PATH bind-mounts the SDK over /opt/aegisx-sdk (dev override)", async () => {
    const { db, dir, close } = setupDb()
    try {
      process.env.AEGISX_SDK_PATH = dir
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedAgent(db, {
        id: "orch-1",
        eventId: "evt-1",
        challengeId: null,
        role: "orchestrator",
        status: "completed",
        sessionFile: "sess-orch-1",
        model: `${TEST_MODEL_REF}:off`,
        systemPrompt: "sp",
        name: "Scheduler",
        createdAt: now(),
        updatedAt: now(),
      })

      const { service, created } = makeService(db, dir, { hang: false })
      await service.sendMessage("orch-1", { text: "wake" })
      await settle()

      const [schedOpts] = refine<
        Array<{
          extraBinds?: string[]
          env?: string[]
        }>
      >(created)
      expect(
        schedOpts.extraBinds?.some((b) => b === `${dir}:/opt/aegisx-sdk:ro`)
      ).toBe(true)
      expect(schedOpts.env).toContain("PYTHONPATH=/opt/aegisx-sdk")
      await service.close()
    } finally {
      delete process.env.AEGISX_SDK_PATH
      close()
    }
  })

  test("assertModelsResolvable rejects a hallucinated model ref with the available list", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { service } = makeService(db, dir)

      const bad = `nope/hallucinated:off`
      expect(() => service.assertModelsResolvable(bad)).toThrow(
        new RegExp(`Available models: .*${TEST_MODEL_REF}`)
      )
      await service.close()
    } finally {
      close()
    }
  })
})
