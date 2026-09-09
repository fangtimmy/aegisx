import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, challengeRemote, challenges } from "../../src/db/schema"
import { parseJson } from "../../src/lib/guards"
import {
  makeAgentService,
  makeProvider,
  stubHostAgentSession,
} from "../helpers"

/** Seed a challenge_remote row marking the challenge platform-integrated and
 * target-capable (drives isPlatformIntegrated / isTargetCapable). */
function seedRemote(
  db: ReturnType<typeof makeService>["db"],
  challengeId: string,
  opts: {
    available?: boolean
    targetSupported?: boolean
    targetIgnored?: boolean
  } = {}
) {
  db.insert(challengeRemote)
    .values({
      challengeId,
      eventId: db
        .select({ eventId: challenges.eventId })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()!.eventId,
      sourceKey: "src",
      remoteId: "remote-1",
      available: opts.available ?? true,
      solved: false,
      targetSupported: opts.targetSupported ?? true,
      targetIgnored: opts.targetIgnored ?? false,
      targetCount: 1,
      targetInfo: "[]",
      syncedAt: new Date().toISOString(),
    })
    .run()
}

function makeService(provider: ReturnType<typeof makeProvider>) {
  const h = makeAgentService({
    providers: [provider],
    createHost: mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    ),
  })
  return { h, db: h.db, service: h.service }
}

describe("classic-parity: spawn on a challenge (v19 path)", () => {
  test("platform + target challenge → solver tools snapshot includes flag + target tools; systemPrompt rendered from builtin mainSystem", async () => {
    const provider = makeProvider()
    const made = makeService(provider)
    try {
      const { db, service } = made
      seedRemote(db, "ch-1")

      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.role, "solver"))
        .get()!

      const tools = parseJson<string[]>(agent.tools)
      expect(tools).toEqual(
        expect.arrayContaining([
          "finish_run",
          "submit_flag",
          "get_target",
          "start_target",
          "extend_target",
          "stop_target",
        ])
      )
      // mainSystem builtin rendered (capabilities injected: canSubmitFlag true).
      expect(agent.systemPrompt).toContain("CTF-solving agent")
      expect(agent.systemPrompt).toContain("submit_flag")
    } finally {
      await made.h.close()
    }
  })

  test("plain challenge (no platform/target) → submit_flag granted, no target tools", async () => {
    const provider = makeProvider()
    const made = makeService(provider)
    try {
      const { db, service } = made
      // no challenge_remote row
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.role, "solver"))
        .get()!

      const tools = parseJson<string[]>(agent.tools)
      expect(tools).toContain("finish_run")
      expect(tools).toContain("submit_flag")
      expect(tools).not.toContain("spawn_agent")
      expect(tools).not.toContain("read_agent")
      // Target tools stay conditional on target capability.
      expect(tools.filter((t) => t.endsWith("_target"))).toEqual([])
      // mainSystem rendered WITH the submit_flag section.
      expect(agent.systemPrompt).toContain("CTF-solving agent")
      expect(agent.systemPrompt).toContain("submit_flag")
    } finally {
      await made.h.close()
    }
  })

  test("spawn yields exactly one solver agent", async () => {
    const provider = makeProvider()
    const made = makeService(provider)
    try {
      const { db, service } = made
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })

      const all = db.select().from(agents).all()
      expect(all).toHaveLength(1)
      expect(all[0].role).toBe("solver")
    } finally {
      await made.h.close()
    }
  })
})
