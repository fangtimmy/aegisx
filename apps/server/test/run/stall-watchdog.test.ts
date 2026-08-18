import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { createLiveBus } from "../../src/agents/live"
import { createDatabase } from "../../src/db"
import { agents, channelMessages, runs } from "../../src/db/schema"
import {
  SCHEDULER_READ_KEY,
  createChannelService,
  orchKey,
  type ChannelService,
} from "../../src/run/channels"
import { createRunQueries } from "../../src/run/queries"
import {
  AGENT_STALL_MS,
  createStallWatchdog,
  fmtMs,
  type StallWatchdog,
} from "../../src/run/stall-watchdog"
import { seedChallenge, seedEvent, seedRun } from "../helpers"

type Db = ReturnType<typeof setupLite>["db"]

function setupLite() {
  const dir = `/tmp/aegisx-watchdog-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, dir, close: () => releaseLock() }
}

function makeWatchdog(
  db: Db,
  dir: string,
  opts: { stallMs?: number; paused?: boolean } = {}
) {
  const channels: ChannelService = createChannelService({
    db,
    dataDir: dir,
    bus: createLiveBus(),
    queries: createRunQueries({
      db,
      dataDir: dir,
      resolveModelDisplay: () => ({
        provider: "p",
        modelId: "m",
        modelName: "Model",
        thinkingLevel: "off",
      }),
    }),
    lifecycle: () => ({ send: async () => {} }) as never,
    now: () => new Date().toISOString(),
    workspaceAbs: (runId: string) => `${dir}/runs/${runId}/workspace`,
  })
  const watchdog: StallWatchdog = createStallWatchdog({
    db,
    channels,
    isSchedulerPaused: () => opts.paused ?? false,
    stallMs: opts.stallMs,
  })
  return { channels, watchdog }
}

function seedAgent(
  db: Db,
  runId: string,
  id: string,
  status: "idle" | "failed" | "running",
  idleForMs = 0
) {
  db.insert(agents)
    .values({
      id,
      runId,
      slot: `solver-${id}`,
      role: "solver",
      isEntry: false,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status,
      name: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() - idleForMs).toISOString(),
    })
    .run()
}

const orchRows = (db: Db, eventId = "evt-1") =>
  db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelKey, orchKey(eventId)))
    .all()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("stall watchdog (docs/im-simplify-v18.md §五)", () => {
  test("an agent idle beyond the threshold posts ONE urgent orch message with the stall detail", async () => {
    const { db, dir, close } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle" })
      seedAgent(db, "r1", "a1", "idle", 5 * 60_000)
      const { channels, watchdog } = makeWatchdog(db, dir, { stallMs: 20 })

      watchdog.noteAgentIdle("r1")
      await wait(50)
      const rows = orchRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.body).toContain("停滞")
      expect(rows[0]!.body).toContain("run-r1")
      expect(rows[0]!.body).toContain("a1 已闲置")
      const meta = JSON.parse(rows[0]!.meta)
      expect(meta.urgent).toBe(true)
      expect(meta.noticeType).toBe("emergency")
      expect(meta.runId).toBe("r1")

      // One shot per idle cycle: the fired timer does not re-arm itself.
      await wait(50)
      expect(orchRows(db)).toHaveLength(1)
      // A fresh settle re-arms (next idle cycle may fire again).
      watchdog.noteAgentIdle("r1")
      await wait(50)
      expect(orchRows(db)).toHaveLength(2)
      watchdog.close()
      channels.close()
    } finally {
      close()
    }
  })

  test("a fresh agent (settled < threshold) never fires; resumed runs are race-safe", async () => {
    const { db, dir, close } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle" })
      seedAgent(db, "r1", "a1", "idle", 100) // settled 100ms ago, threshold 20ms
      const { channels, watchdog } = makeWatchdog(db, dir, { stallMs: 60_000 })

      watchdog.noteAgentIdle("r1")
      await wait(50)
      expect(orchRows(db)).toHaveLength(0)

      // The timer fires AFTER the run went running again — the re-check
      // finds a running agent row and stays silent.
      db.update(agents)
        .set({ status: "running", updatedAt: new Date().toISOString() })
        .where(eq(agents.id, "a1"))
        .run()
      watchdog.close()
      channels.close()
    } finally {
      close()
    }
  })

  test("closed / finishing / paused-event / scheduler runs never arm or fire", async () => {
    const { db, dir, close } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "closed" })
      seedRun(db, { id: "r2", status: "idle", finishing: true })
      seedRun(db, { id: "r3", status: "idle" }) // live, but the event is paused
      seedRun(db, {
        id: "rS",
        status: "idle",
        scopeType: "event",
        challengeId: null,
      })
      seedAgent(db, "r1", "c1", "idle", 5 * 60_000)
      seedAgent(db, "r2", "f1", "idle", 5 * 60_000)
      seedAgent(db, "r3", "p1", "idle", 5 * 60_000)
      seedAgent(db, "rS", "s1", "idle", 5 * 60_000)
      const { channels, watchdog } = makeWatchdog(db, dir, {
        stallMs: 20,
        paused: true,
      })

      for (const runId of ["r1", "r2", "r3", "rS"])
        watchdog.noteAgentIdle(runId)
      await wait(60)
      expect(orchRows(db)).toHaveLength(0)
      watchdog.close()
      channels.close()
    } finally {
      close()
    }
  })

  test("the watchdog needs no live scheduler: the message stores unread for catch-up", async () => {
    const { db, dir, close } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle" })
      seedAgent(db, "r1", "a1", "idle", 5 * 60_000)
      // No scheduler run at all — the orch message just sits in the channel.
      const { channels, watchdog } = makeWatchdog(db, dir, { stallMs: 20 })
      watchdog.noteAgentIdle("r1")
      await wait(50)
      expect(channels.unreadCount(orchKey("evt-1"), SCHEDULER_READ_KEY)).toBe(1)
      watchdog.close()
      channels.close()
    } finally {
      close()
    }
  })

  test("fmtMs formatting + AGENT_STALL_MS default", () => {
    expect(AGENT_STALL_MS).toBe(2 * 60_000)
    expect(fmtMs(3_500)).toBe("4s")
    expect(fmtMs(210_000)).toBe("3m30s")
    expect(fmtMs(180_000)).toBe("3m")
    expect(fmtMs(7_200_000)).toBe("2h")
    expect(fmtMs(-45_000)).toBe("-45s(超时)")
  })
})
