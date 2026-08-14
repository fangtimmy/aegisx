import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, challengeRemote, challenges } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
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

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

function baseCreateInput(challengeId: string) {
  return {
    input: {
      scopeType: "challenge" as const,
      challengeId,
      container: containerInput,
    },
    provider: makeProvider(),
  }
}

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
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string,
  provider: ReturnType<typeof makeProvider>
) {
  const { manager } = stubContainerManager()
  return createRunService({
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
    createHost: mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    ),
  })
}

describe("classic plugin end-to-end (service-level parity)", () => {
  test("platform + target challenge → solver tools snapshot includes flag + target tools; systemPrompt rendered from builtin mainSystem", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRemote(db, "ch-1")
      const { input, provider } = baseCreateInput("ch-1")
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create(input)
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .get()!
      await runService.close()

      expect(agent.slot).toBe("solver")
      expect(agent.isEntry).toBe(true)
      const tools = JSON.parse(agent.tools) as string[]
      expect(tools).toEqual(
        expect.arrayContaining([
          "finish_run",
          "submit_flag",
          "get_target",
          "start_target",
          "extend_target",
          "stop_target",
          "spawn_agent",
          "read_agent",
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
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // no challenge_remote row
      const { input, provider } = baseCreateInput("ch-1")
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create(input)
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .get()!
      await runService.close()

      const tools = JSON.parse(agent.tools) as string[]
      expect(tools).toContain("finish_run")
      expect(tools).toContain("submit_flag")
      expect(tools).toContain("spawn_agent")
      expect(tools).toContain("read_agent")
      // Target tools stay conditional on target capability (spec §6).
      expect(tools.filter((t) => t.endsWith("_target"))).toEqual([])
      // mainSystem rendered WITH the submit_flag section — the tool records
      // non-platform flags as locally accepted (spec §7.1 / flags.ts).
      expect(agent.systemPrompt).toContain("CTF-solving agent")
      expect(agent.systemPrompt).toContain("submit_flag")
    } finally {
      close()
    }
  })

  test("exactly one entry agent declared; orchestration = classic", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { input, provider } = baseCreateInput("ch-1")
      const runService = makeService(db, sqlite, dir, provider)

      const run = await runService.create(input)
      await runService.close()

      expect(run.orchestration).toBe("classic")
      const all = db.select().from(agents).where(eq(agents.runId, run.id)).all()
      expect(all).toHaveLength(1)
      expect(all.filter((a) => a.isEntry)).toHaveLength(1)
    } finally {
      close()
    }
  })
})
