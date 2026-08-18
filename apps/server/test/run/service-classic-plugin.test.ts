import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, challengeRemote, challenges } from "../../src/db/schema"
import { createAgentService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
} from "../helpers"

/** Seed a challenge_remote row marking the challenge platform-integrated and
 * target-capable (drives isPlatformIntegrated / isTargetCapable). */
function seedRemote(
  db: ReturnType<typeof setupDb>["db"],
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

function makeService(
  db: ReturnType<typeof setupDb>["db"],
  dir: string,
  provider: ReturnType<typeof makeProvider>
) {
  const { manager } = stubContainerManager()
  return createAgentService({
    db,
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
    createHost: mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    ),
  })
}

describe("classic-parity: spawn on a challenge (v19 path)", () => {
  test("platform + target challenge → solver tools snapshot includes flag + target tools; systemPrompt rendered from builtin mainSystem", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRemote(db, "ch-1")
      const provider = makeProvider()
      const service = makeService(db, dir, provider)

      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.role, "solver"))
        .get()!
      await service.close()

      const tools = JSON.parse(agent.tools) as string[]
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
      close()
    }
  })

  test("plain challenge (no platform/target) → submit_flag granted, no target tools", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // no challenge_remote row
      const provider = makeProvider()
      const service = makeService(db, dir, provider)

      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.role, "solver"))
        .get()!
      await service.close()

      const tools = JSON.parse(agent.tools) as string[]
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
      close()
    }
  })

  test("spawn yields exactly one solver agent", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const service = makeService(db, dir, provider)

      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" })
      await service.close()

      const all = db.select().from(agents).all()
      expect(all).toHaveLength(1)
      expect(all[0]!.role).toBe("solver")
    } finally {
      close()
    }
  })
})
