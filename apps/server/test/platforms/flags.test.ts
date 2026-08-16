import { describe, expect, test } from "bun:test"

import { createStorage } from "../../src/infrastructure/storage"
import { createPlatformService } from "../../src/platforms/service"
import { seedChallenge, seedEvent, setupDb, stubConfigStore } from "../helpers"

describe("platform flags → run hook", () => {
  function makePlatform(db: ReturnType<typeof setupDb>["db"], dir: string) {
    const accepted: string[] = []
    const platform = createPlatformService(
      db,
      createStorage(dir),
      () => 1024 * 1024,
      stubConfigStore([])
    )
    platform.setRunHooks({ onRunFlagAccepted: (runId) => accepted.push(runId) })
    return { platform, accepted }
  }

  test("non-platform accepted flag notifies the run layer", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { platform, accepted } = makePlatform(db, dir)

      const result = await platform.submitFlag("run-1", "ch-1", "flag{test}")
      expect(result.status).toBe("accepted")
      expect(accepted).toEqual(["run-1"])
    } finally {
      close()
    }
  })

  test("repeat submission of an accepted flag notifies the submitting run", async () => {
    const { db, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { platform, accepted } = makePlatform(db, dir)

      await platform.submitFlag("run-1", "ch-1", "flag{test}")
      // Terminal cache hit: already accepted, but the submitting run must
      // still notify the scheduler (its own run.flagAccepted).
      const second = await platform.submitFlag("run-2", "ch-1", "flag{test}")
      expect(second.status).toBe("accepted")
      expect(accepted).toEqual(["run-1", "run-2"])
    } finally {
      close()
    }
  })
})
