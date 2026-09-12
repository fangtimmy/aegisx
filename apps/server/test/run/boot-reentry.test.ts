import { describe, expect, test } from "bun:test"

import { NOTICE_TEMPLATE_DEFAULTS } from "../../src/orchestration/prompt-defaults"
import { notifyBootReentry } from "../../src/run/boot-reentry"
import {
  makeAgentService,
  promptRecordingHost,
  seedAgent,
  seedChallenge,
  seedEvent,
  setupDb,
  SYSTEM,
  USER,
} from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]

function collect(db: Db, paused = false) {
  const sends: Array<{ agentId: string; text: string }> = []
  return {
    sends,
    run: () =>
      notifyBootReentry({
        db,
        send: async (agentId, text) => {
          sends.push({ agentId, text })
        },
        templateBody: (key) => NOTICE_TEMPLATE_DEFAULTS[key],
        isSchedulerPaused: () => paused,
      }),
  }
}

describe("boot re-entry (restart → scheduler only)", () => {
  test("a surviving scheduler gets ONE prompt carrying the idle-agent count", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, {
        id: "sched",
        role: "orchestrator",
        challengeId: null,
        status: "idle",
      })
      // Two live solvers + one terminal attempt.
      seedAgent(db, { id: "s1", status: "idle" })
      seedAgent(db, { id: "s2", status: "running" })
      seedAgent(db, { id: "s3", status: "completed" })

      const { sends, run } = collect(db)
      await run()

      expect(sends).toHaveLength(1)
      expect(sends[0].agentId).toBe("sched")
      expect(sends[0].text).toContain("服务已重启")
      expect(sends[0].text).toContain("2 个存活 agent")
    } finally {
      close()
    }
  })

  test("a paused scheduler is skipped", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, {
        id: "sched",
        role: "orchestrator",
        challengeId: null,
        status: "idle",
      })
      const { sends, run } = collect(db, true)
      await run()
      expect(sends).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("no scheduler, no send, no throw", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, { id: "s1", status: "idle" })
      const { sends, run } = collect(db)
      await run()
      expect(sends).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("recoverOnBoot wakes the surviving scheduler through the service", async () => {
    const promptLog = new Map<string, string[]>()
    const h = makeAgentService({ createHost: promptRecordingHost(promptLog) })
    try {
      await h.service.startScheduler("evt-1")
      const scheduler = h.service.getSchedulerAgent("evt-1", SYSTEM)!
      await h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      await h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)

      await h.service.recoverOnBoot()

      const prompts = promptLog.get(scheduler.id)!
      expect(prompts.length).toBe(2)
      expect(prompts[1]).toContain("服务已重启")
      expect(prompts[1]).toContain("2 个存活 agent")
    } finally {
      await h.close()
    }
  })
})
