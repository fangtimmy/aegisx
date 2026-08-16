import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { runQueue } from "../../src/db/schema"
import { createSchedulerInbox, fmtMs } from "../../src/run/scheduler-inbox"
import {
  flatSettings,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
} from "../helpers"

type Db = ReturnType<typeof setupDb>["db"]

/** seconds-ago ISO (server timestamps are Z-suffixed UTC). */
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString()

function makeInbox(
  db: Db,
  opts: { eventId?: string; silenceMs?: number; paused?: boolean } = {}
) {
  const eventId = opts.eventId ?? "evt-1"
  const sent: string[] = []
  const inbox = createSchedulerInbox({
    eventId,
    orchestratorAgentId: "orch-1",
    db,
    getSettings: flatSettings,
    send: (text) => sent.push(text),
    now: () => new Date().toISOString(),
    isPaused: () => opts.paused ?? false,
    silenceMs: opts.silenceMs,
  })
  return { inbox, sent }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function queuePending(db: Db, eventId = "evt-1"): number {
  return db
    .select({ id: runQueue.id })
    .from(runQueue)
    .where(eq(runQueue.eventId, eventId))
    .all().length
}

describe("fmtMs (digest / SDK shared format)", () => {
  test("seconds, minutes, hours, negatives", () => {
    expect(fmtMs(3_500)).toBe("4s")
    expect(fmtMs(40_000)).toBe("40s")
    expect(fmtMs(60_000)).toBe("1m")
    expect(fmtMs(210_000)).toBe("3m30s")
    expect(fmtMs(1_380_000)).toBe("23m")
    expect(fmtMs(3_600_000)).toBe("1h")
    expect(fmtMs(3_660_000)).toBe("1h1m")
    expect(fmtMs(-45_000)).toBe("-45s(超时)")
    expect(fmtMs(-210_000)).toBe("-3m30s(超时)")
  })
})

describe("scheduler inbox (docs/scheduler-inbox.md)", () => {
  test("ordinary events only queue; a silent window flushes them in one digest", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, {
        id: "r1",
        status: "idle",
        startedAt: ago(120),
        updatedAt: ago(30),
      })
      const { inbox, sent } = makeInbox(db, { silenceMs: 30 })
      inbox.push({ type: "run.started", runId: "r1" })
      inbox.push({ type: "run.idle", runId: "r1" })
      expect(sent).toHaveLength(0) // queued, not woken

      await wait(80)
      expect(sent).toHaveLength(1) // one flush for both events
      const digest = sent[0]!
      expect(digest).toContain("[调度事件摘要")
      expect(digest).toContain("r1")
      expect(digest).toContain("started→idle")
      // Time columns rendered from the run row (idle → 闲置时长).
      expect(digest).toContain("idle 30s")
      // Stats line: active 1/4 (default cap) · pending 0.
      expect(digest).toContain("active 1/4 · pending 0")
    } finally {
      close()
    }
  })

  test("new messages refresh the silent timer (burst stays queued)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(5) })
      const { inbox, sent } = makeInbox(db, { silenceMs: 40 })
      inbox.push({ type: "run.started", runId: "r1" })
      await wait(25) // before the 40ms window
      inbox.push({ type: "run.idle", runId: "r1" }) // refreshes the timer
      expect(sent).toHaveLength(0)
      await wait(25)
      expect(sent).toHaveLength(0) // refreshed: still quiet
      await wait(30)
      expect(sent).toHaveLength(1) // flushed after the refreshed window
      expect(sent[0]).toContain("started→idle")
    } finally {
      close()
    }
  })

  test("timedOut flushes immediately, carrying queued ordinary lines", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, {
        id: "r1",
        status: "closed",
        startedAt: ago(600),
        completedAt: ago(60),
      })
      const { inbox, sent } = makeInbox(db)
      inbox.push({ type: "run.started", runId: "r1" })
      expect(sent).toHaveLength(0)
      inbox.push({ type: "run.timedOut", runId: "r1", outcome: "closed" })
      expect(sent).toHaveLength(1) // immediate
      const digest = sent[0]!
      expect(digest).toContain("started→timedOut(closed)")
      expect(digest).toContain("closed")
      expect(digest).toContain("耗时 9m")
    } finally {
      close()
    }
  })

  test("queue emergencies push an ⚠ line and flush immediately; paused is silent", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const { inbox, sent } = makeInbox(db)
      inbox.pushEmergency("队列不足：仅剩最后 1 项排队")
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("⚠ 队列不足：仅剩最后 1 项排队")

      const paused = makeInbox(db, { paused: true })
      paused.inbox.pushEmergency("启动失败：ch-1 — boom")
      expect(paused.sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("a failed idle marks the event sequence", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(10) })
      const { inbox, sent } = makeInbox(db, { silenceMs: 30 })
      inbox.push({ type: "run.idle", runId: "r1", failed: true })
      await wait(80)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("idle(failed)")
    } finally {
      close()
    }
  })

  test("deadline column: remaining, near-deadline ⚠, and overdue", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, {
        id: "r1",
        status: "running",
        startedAt: ago(600),
        updatedAt: ago(20),
        deadlineAt: ago(-300), // 5min left → near-deadline
      })
      seedRun(db, {
        id: "r2",
        status: "running",
        startedAt: ago(600),
        updatedAt: ago(20),
        deadlineAt: ago(60), // overdue
      })
      seedRun(db, {
        id: "r3",
        status: "idle",
        updatedAt: ago(30 * 60 + 5), // 30min quiet → stalled
      })
      const { inbox, sent } = makeInbox(db, { silenceMs: 30 })
      inbox.push({ type: "run.started", runId: "r1" })
      inbox.push({ type: "run.started", runId: "r2" })
      inbox.push({ type: "run.idle", runId: "r3" })
      await wait(80)
      const digest = sent[0]!
      expect(digest).toContain("deadline剩 5m")
      expect(digest).toContain("⚠ 临近deadline")
      expect(digest).toContain("deadline超 1m")
      expect(digest).toContain("⚠ 停滞") // r3 idle 30min
    } finally {
      close()
    }
  })

  test("more than 20 runs fold into an overflow line", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const { inbox, sent } = makeInbox(db, { silenceMs: 30 })
      for (let i = 0; i < 23; i++) {
        seedRun(db, { id: `r${i}`, status: "idle", updatedAt: ago(5) })
        inbox.push({ type: "run.idle", runId: `r${i}` })
      }
      await wait(80)
      const digest = sent[0]!
      expect(digest).toContain("…另有 3 个 run 事件")
      expect(digest.match(/^run-/gm)!.length).toBe(20) // shown lines capped
    } finally {
      close()
    }
  })

  test("stats line counts active runs and pending queue items", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, {
        id: "r1",
        status: "running",
        startedAt: ago(60),
        updatedAt: ago(10),
      })
      seedRun(db, { id: "r2", status: "idle", updatedAt: ago(10) })
      seedRun(db, { id: "r3", status: "closed", updatedAt: ago(10) })
      db.insert(runQueue)
        .values({
          id: "q1",
          eventId: "evt-1",
          ord: 1,
          challengeId: "ch-1",
          params: "{}",
          prompt: "p",
          source: "scheduler",
          status: "pending",
          createdAt: ago(10),
          updatedAt: ago(10),
        })
        .run()
      const { inbox, sent } = makeInbox(db, { silenceMs: 30 })
      inbox.push({ type: "run.idle", runId: "r2" })
      await wait(80)
      expect(sent[0]).toContain("active 2/4 · pending 1")
      expect(queuePending(db)).toBe(1)
    } finally {
      close()
    }
  })

  test("close clears the queue and timer (no late flush)", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(5) })
      const { inbox, sent } = makeInbox(db, { silenceMs: 30 })
      inbox.push({ type: "run.idle", runId: "r1" })
      inbox.close()
      await wait(80)
      expect(sent).toHaveLength(0)
    } finally {
      close()
    }
  })
})
