import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import {
  makeAgentService,
  now,
  seedAgent,
  stubHostAgentSession,
  TEST_MODEL_REF,
  USER,
} from "../helpers"
import { refine } from "../support"

/** Service with a stubbed container + host session (no real Docker / LLM). */
function makeService(opts: { hang?: boolean } = {}) {
  const hang = opts.hang ?? true
  const h = makeAgentService({
    createHost: mock(async (input: { agentId: string }) => {
      const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
        hang,
      })
      const sdk = refine<{
        prompt: () => Promise<void>
      }>(stub.session)
      sdk.prompt = async () => {
        if (hang) await new Promise(() => {})
      }
      return stub
    }),
  })
  return {
    h,
    db: h.db,
    dir: h.dir,
    service: h.service,
    created: h.stubs.created,
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

/**
 * Scheduler service behaviors the `aegisx` SDK maps to. The orchestrator's
 * native management tool set is EMPTY (ORCHESTRATOR_TOOLS = []) — the SDK
 * drives these service paths over HTTP, so the coverage lives here.
 */
describe("scheduler service behaviors (SDK backend)", () => {
  test("the orchestrator agent gets NO management tools (SDK replaces them)", async () => {
    const made = makeService()
    try {
      const { db, service } = made

      const sched = await service.startScheduler("evt-1")

      expect(sched.role).toBe("orchestrator")
      const row = db.select().from(agents).where(eq(agents.id, sched.id)).get()!
      // SDK convergence: the snapshot grants no management tools; the
      // orchestrator manages via `aegisx` + the four file/bash tools.
      expect(JSON.parse(row.tools)).toEqual([])
    } finally {
      await made.h.close()
    }
  })

  test("containers default to the image SDK: event env, no bind mount, no ROLE", async () => {
    delete process.env.AEGISX_SDK_PATH
    const made = makeService({ hang: false })
    try {
      const { db, dir, service, created } = made
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

      await service.sendMessage("orch-1", { text: "wake" }, USER)
      await settle()
      // A fresh solver spawn builds the challenge container.
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
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
    } finally {
      await made.h.close()
    }
  })

  test("AEGISX_SDK_PATH bind-mounts the SDK over /opt/aegisx-sdk (dev override)", async () => {
    const made = makeService({ hang: false })
    try {
      const { db, dir, service, created } = made
      process.env.AEGISX_SDK_PATH = dir
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

      await service.sendMessage("orch-1", { text: "wake" }, USER)
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
    } finally {
      delete process.env.AEGISX_SDK_PATH
      await made.h.close()
    }
  })

  test("assertModelsResolvable rejects a hallucinated model ref with the available list", async () => {
    const made = makeService()
    try {
      const { service } = made

      const bad = `nope/hallucinated:off`
      expect(() => service.assertModelsResolvable(bad)).toThrow(
        new RegExp(`Available models: .*${TEST_MODEL_REF}`)
      )
    } finally {
      await made.h.close()
    }
  })
})
