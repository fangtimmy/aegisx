import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, runs } from "../../src/db/schema"
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
  now,
} from "../helpers"

/** A service wired against a stub container/host (sessions hang so a restored
 * run stays deterministically `running`). */
function makeService(
  db: ReturnType<typeof setupDb>["db"],
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
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
    createHost: mock(async () =>
      stubHostAgentSession("sess-1", { hang: true })
    ),
  })
  return { service, manager }
}

describe("finishing flag lifecycle (code-review P1)", () => {
  test("recoverOnBoot resets finishing on crashed running/idle runs", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Crash mid-finish: finishing=1 with the teardown never run.
      seedRun(db, { id: "r-1", status: "running", finishing: true })
      seedRun(db, { id: "r-2", status: "idle", finishing: true })

      const { service } = makeService(db, sqlite, dir)
      await service.recoverOnBoot()

      for (const id of ["r-1", "r-2"]) {
        const row = db.select().from(runs).where(eq(runs.id, id)).get()!
        expect(row.status).toBe("closed")
        expect(row.finishing).toBe(false)
      }
      await service.close()
    } finally {
      close()
    }
  })

  test("cold restore resets finishing so finish_run can claim again", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // A closed run whose prior finish was interrupted (finishing still set).
      seedRun(db, {
        id: "r-1",
        status: "closed",
        finishing: true,
        challengeId: "ch-1",
        eventId: "evt-1",
      })
      db.insert(agents)
        .values({
          id: "a-1",
          runId: "r-1",
          slot: "solver",
          role: "solver",
          isEntry: true,
          model: "openai/gpt-4o-mini:off",
          systemPrompt: "sp",
          tools: "[]",
          status: "idle",
          sessionFile: "sess-1",
          name: "Solver",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const { service } = makeService(db, sqlite, dir)
      // Messaging the closed run cold-restores it (hang session → running).
      await service.sendMessage("r-1", { text: "ping" })

      const row = db.select().from(runs).where(eq(runs.id, "r-1")).get()!
      expect(row.status).toBe("running")
      expect(row.finishing).toBe(false)
      // finish_run can claim again — the stale intent is void.
      expect(service.markFinishing("r-1")).toBe(true)
      await service.close()
    } finally {
      close()
    }
  })

  test("markFinishing refuses to claim a closed run (no double teardown)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, { id: "r-closed", status: "closed" })
      seedRun(db, { id: "r-running", status: "running" })

      const { service } = makeService(db, sqlite, dir)
      // A late finish_run on an already-closed run must not claim.
      expect(service.markFinishing("r-closed")).toBe(false)
      // Live runs still claim (idempotent once — second call loses).
      expect(service.markFinishing("r-running")).toBe(true)
      expect(service.markFinishing("r-running")).toBe(false)
      await service.close()
    } finally {
      close()
    }
  })
})
