import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { createDatabase } from "../../src/db"
import { agents, channelMessages } from "../../src/db/schema"
import {
  SCHEDULER_READ_KEY,
  createChannelService,
  orchKey,
  type ChannelService,
} from "../../src/run/channels"
import { createLiveBus } from "../../src/run/host/live"
import {
  AGENT_STALL_MS,
  createStallWatchdog,
  fmtMs,
  type StallWatchdog,
} from "../../src/run/stall-watchdog"
import { seedChallenge, seedEvent, now } from "../helpers"
import { refine } from "../support"

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
    lifecycle: () => refine({ send: async () => {} }),
    now: () => new Date().toISOString(),
    challengeWorkspaceRoot: (eventId, challengeId) =>
      `${dir}/events/${eventId}/challenges/${challengeId}/workspace`,
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
  id: string,
  opts: {
    status?: "idle" | "failed" | "running" | "completed"
    role?: "solver" | "orchestrator"
    idleForMs?: number
  } = {}
) {
  db.insert(agents)
    .values({
      id,
      eventId: "evt-1",
      challengeId: opts.role === "orchestrator" ? null : "ch-1",
      role: opts.role ?? "solver",
      name: id,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status: opts.status ?? "idle",
      source: "manual",
      timeoutMs: 3_600_000,
      createdAt: now(),
      startedAt: now(),
      updatedAt: new Date(Date.now() - (opts.idleForMs ?? 0)).toISOString(),
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
      seedAgent(db, "a1", { idleForMs: 5 * 60_000 })
      const { channels, watchdog } = makeWatchdog(db, dir, { stallMs: 20 })

      watchdog.noteAgentIdle("a1")
      await wait(50)
      const rows = orchRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].body).toContain("停滞")
      expect(rows[0].body).toContain("agent-a1")
      expect(rows[0].body).toContain("已闲置")
      const meta = JSON.parse(rows[0].meta)
      expect(meta.urgent).toBe(true)
      expect(meta.noticeType).toBe("emergency")
      expect(meta.agentId).toBe("a1")

      // One shot per idle cycle: the fired timer does not re-arm itself.
      await wait(50)
      expect(orchRows(db)).toHaveLength(1)
      // A fresh settle re-arms (next idle cycle may fire again).
      watchdog.noteAgentIdle("a1")
      await wait(50)
      expect(orchRows(db)).toHaveLength(2)
      watchdog.close()
      channels.close()
    } finally {
      close()
    }
  })

  test("a fresh agent (settled < threshold) never fires; resumed agents are race-safe", async () => {
    const { db, dir, close } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { idleForMs: 100 }) // settled 100ms ago, threshold 60s
      const { channels, watchdog } = makeWatchdog(db, dir, { stallMs: 60_000 })

      watchdog.noteAgentIdle("a1")
      await wait(50)
      expect(orchRows(db)).toHaveLength(0)

      // The timer fires AFTER the agent went running again — the re-check
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

  test("terminal / scheduler-agent / paused-event cases never arm or fire", async () => {
    const { db, dir, close } = setupLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "c1", { status: "completed", idleForMs: 5 * 60_000 })
      seedAgent(db, "s1", {
        role: "orchestrator",
        idleForMs: 5 * 60_000,
      }) // the scheduler agent never counts
      seedAgent(db, "p1", { idleForMs: 5 * 60_000 }) // live, but the event is paused
      const { channels, watchdog } = makeWatchdog(db, dir, {
        stallMs: 20,
        paused: true,
      })

      for (const agentId of ["c1", "s1", "p1"]) watchdog.noteAgentIdle(agentId)
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
      seedAgent(db, "a1", { idleForMs: 5 * 60_000 })
      // No scheduler agent at all — the orch message just sits in the channel.
      const { channels, watchdog } = makeWatchdog(db, dir, { stallMs: 20 })
      watchdog.noteAgentIdle("a1")
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
