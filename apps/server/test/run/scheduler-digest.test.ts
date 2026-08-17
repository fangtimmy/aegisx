import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { createLiveBus } from "../../src/agents/live"
import { createDatabase } from "../../src/db"
import {
  agents,
  channelMessages,
  channelReads,
  runs,
  runQueue,
} from "../../src/db/schema"
import {
  createChannelService,
  type ChannelService,
} from "../../src/run/channels"
import { createRunQueries } from "../../src/run/queries"
import {
  createSchedulerDigest,
  fmtMs,
  type SchedulerDigest,
} from "../../src/run/scheduler-digest"
import { flatSettings, seedChallenge, seedEvent, seedRun } from "../helpers"

type Db = ReturnType<typeof setupDbLite>["db"]

/** seconds-ago ISO (server timestamps are Z-suffixed UTC). */
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setupDbLite() {
  const dir = `/tmp/aegisx-digest-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, dir, close: () => releaseLock() }
}

/**
 * Wires the real production chain: digest posts → channels.post →
 * onSchedulerDmMessage routes back to the digest's policy (same wiring as
 * service.ts digestFor). The channel service is created first; the digest
 * registers itself into a holder the callback reads.
 */
function makeDigest(
  db: Db,
  dir: string,
  opts: {
    eventId?: string
    orchestratorAgentId?: string
    silenceMs?: number
    stallMs?: number
    paused?: boolean
  } = {}
) {
  const eventId = opts.eventId ?? "evt-1"
  const orchestratorAgentId = opts.orchestratorAgentId ?? "orch-1"
  const sent: string[] = []
  let digestRef: SchedulerDigest | null = null
  const queries = createRunQueries({
    db,
    dataDir: dir,
    resolveModelDisplay: () => ({
      provider: "p",
      modelId: "m",
      modelName: "Model",
      thinkingLevel: "off",
    }),
  })
  const channels: ChannelService = createChannelService({
    db,
    dataDir: dir,
    bus: createLiveBus(),
    queries,
    lifecycle: { send: async () => {} } as never,
    now: () => new Date().toISOString(),
    workspaceAbs: (runId) => `${dir}/runs/${runId}/workspace`,
    onSchedulerDmMessage: (_eventId, message) => {
      digestRef?.onMessage(message)
    },
  })
  channels.ensureSchedulerDm(eventId, orchestratorAgentId)
  const digest = createSchedulerDigest({
    eventId,
    orchestratorAgentId,
    db,
    getSettings: flatSettings,
    channels,
    send: (text) => sent.push(text),
    now: () => new Date().toISOString(),
    isPaused: () => opts.paused ?? false,
    silenceMs: opts.silenceMs,
    stallMs: opts.stallMs,
  })
  digestRef = digest
  return { channels, digest, sent }
}

/** The scheduler DM channel row id (recap/cursor assertions). */
function dmId(db: Db, eventId = "evt-1"): string {
  return db
    .select()
    .from(channelReads)
    .where(eq(channelReads.agentId, "scheduler"))
    .get()!.channelId
}

function recapRows(db: Db, channelId: string) {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .all()
    .filter((row) => row.kind === "recap")
}

/** Minimal agent row for stall-watchdog tests. */
function seedAgent(
  db: Db,
  runId: string,
  overrides: Partial<typeof agents.$inferInsert> = {}
) {
  db.insert(agents)
    .values({
      id: overrides.id ?? `ag-${runId}`,
      runId,
      slot: overrides.slot ?? "solver-1",
      role: "solver",
      isEntry: true,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status: "idle",
      createdAt: ago(600),
      updatedAt: ago(600),
      ...overrides,
    })
    .run()
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

describe("scheduler digest (docs/im-channels.md §三)", () => {
  test("ordinary events persist to the DM + queue; a silent window flushes them in one digest", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, {
        id: "r1",
        status: "idle",
        startedAt: ago(120),
        updatedAt: ago(30),
      })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.started", runId: "r1" })
      digest.push({ type: "run.idle", runId: "r1" })
      expect(sent).toHaveLength(0) // queued, not woken

      // Persist-first red line: the events are ALREADY in the DM ledger.
      const stored = db
        .select()
        .from(channelMessages)
        .all()
        .filter((row) => row.kind === "text")
      expect(stored.map((row) => row.body)).toEqual(["started", "idle"])

      await wait(80)
      expect(sent).toHaveLength(1) // one flush for both events
      const digestText = sent[0]!
      expect(digestText).toContain("[调度事件摘要")
      expect(digestText).toContain("r1")
      expect(digestText).toContain("started→idle")
      expect(digestText).toContain("idle 30s")
      expect(digestText).toContain("active 1/4 · pending 0")
    } finally {
      close()
    }
  })

  test("new messages refresh the silent timer (burst stays queued)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(5) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 40 })
      digest.push({ type: "run.started", runId: "r1" })
      await wait(25) // before the 40ms window
      digest.push({ type: "run.idle", runId: "r1" }) // refreshes the timer
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
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, {
        id: "r1",
        status: "closed",
        startedAt: ago(600),
        completedAt: ago(60),
      })
      const { digest, sent } = makeDigest(db, dir)
      digest.push({ type: "run.started", runId: "r1" })
      expect(sent).toHaveLength(0)
      digest.push({ type: "run.timedOut", runId: "r1", outcome: "closed" })
      expect(sent).toHaveLength(1) // immediate
      const digestText = sent[0]!
      expect(digestText).toContain("started→timedOut(closed)")
      expect(digestText).toContain("closed")
      expect(digestText).toContain("耗时 9m")
    } finally {
      close()
    }
  })

  test("queue emergencies push an ⚠ line and flush immediately; paused is silent", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const { digest, sent } = makeDigest(db, dir)
      digest.pushEmergency("队列不足：仅剩最后 1 项排队")
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("⚠ 队列不足：仅剩最后 1 项排队")

      const paused = makeDigest(db, dir, { paused: true })
      paused.digest.pushEmergency("启动失败：ch-1 — boom")
      expect(paused.sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("a failed idle marks the event sequence", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(10) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.idle", runId: "r1", failed: true })
      await wait(80)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("idle(failed)")
    } finally {
      close()
    }
  })

  test("deadline column: remaining, near-deadline ⚠, and overdue", async () => {
    const { db, dir, close } = setupDbLite()
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
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.started", runId: "r1" })
      digest.push({ type: "run.started", runId: "r2" })
      digest.push({ type: "run.idle", runId: "r3" })
      await wait(80)
      const digestText = sent[0]!
      expect(digestText).toContain("deadline剩 5m")
      expect(digestText).toContain("⚠ 临近deadline")
      expect(digestText).toContain("deadline超 1m")
      expect(digestText).toContain("⚠ 停滞") // r3 idle 30min
    } finally {
      close()
    }
  })

  test("more than 20 runs fold into an overflow line", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      for (let i = 0; i < 23; i++) {
        seedRun(db, { id: `r${i}`, status: "idle", updatedAt: ago(5) })
        digest.push({ type: "run.idle", runId: `r${i}` })
      }
      await wait(80)
      const digestText = sent[0]!
      expect(digestText).toContain("…另有 3 个 run 事件")
      expect(digestText.match(/^run-/gm)!.length).toBe(20) // shown lines capped
    } finally {
      close()
    }
  })

  test("unread backlog beyond 200 folds into a fold line", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      // system posts are non-urgent: they accumulate (silence-timer flush)
      // instead of flushing per message, so a >200 backlog is reachable.
      const { channels, sent } = makeDigest(db, dir, { silenceMs: 30 })
      const dm = channels.schedulerDm("evt-1")!.id
      for (let i = 0; i < 210; i++) {
        channels.post({
          channelId: dm,
          author: { type: "system" },
          body: `notice-${i}`,
        })
      }
      await wait(120)
      const digestText = sent[0]!
      expect(digestText).toContain("另有 10 条更早消息未读")
      expect(digestText).toContain("notice-209")
      expect(digestText).toContain("notice-10") // newest page kept
    } finally {
      close()
    }
  })

  test("stats line counts active runs and pending queue items", async () => {
    const { db, dir, close } = setupDbLite()
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
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.idle", runId: "r2" })
      await wait(80)
      expect(sent[0]).toContain("active 2/4 · pending 1")
    } finally {
      close()
    }
  })

  test("close clears the queue and timer (no late flush)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(5) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.idle", runId: "r1" })
      digest.close()
      await wait(80)
      expect(sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("crash recovery: unflushed unread survives close; a fresh digest catch-up arms and settles", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(5) })
      // Instance 1 crashes (close without flush) with a queued event.
      const first = makeDigest(db, dir, { silenceMs: 30 })
      first.digest.push({ type: "run.started", runId: "r1" })
      first.digest.close()
      await wait(80)
      expect(first.sent).toHaveLength(0)

      // Instance 2 (scheduler restart): the creation catch-up sees the
      // stored unread and arms the silence timer — the backlog settles
      // without anyone re-pushing the event.
      const second = makeDigest(db, dir, { silenceMs: 30 })
      expect(second.digest.snapshot().silence.armed).toBe(true)
      await wait(80)
      expect(second.sent).toHaveLength(1)
      expect(second.sent[0]).toContain("started")
    } finally {
      close()
    }
  })

  test("notices queue silently and ride the next digest; paused is silent", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(30) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.pushNotice("队列已暂停（用户手动控制）")
      expect(sent).toHaveLength(0) // not urgent — queued, no immediate flush
      await wait(80)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("队列已暂停（用户手动控制）")
      // Notice rides an urgent flush too (no waiting for the quiet window).
      digest.pushNotice("队列已恢复（用户手动控制）")
      digest.pushEmergency("队列不足：仅剩最后 1 项排队")
      expect(sent[1]).toContain("队列已恢复（用户手动控制）")
      expect(sent[1]).toContain("⚠ 队列不足")

      const paused = makeDigest(db, dir, { paused: true })
      paused.digest.pushNotice("队列已暂停（用户手动控制）")
      expect(paused.sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("a solver ask and a user post ride the digest (ask queued; user urgent)", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running", updatedAt: ago(5) })
      seedAgent(db, "r1", { name: "Solver 1", id: "a1", status: "running" })
      const { channels, sent } = makeDigest(db, dir)
      const dm = channels.schedulerDm("evt-1")!
      // Solver ask: agent post → queued (silence timer), not urgent. No
      // meta passed — the server stamps runId from the agent row.
      channels.post({
        channelId: dm.id,
        author: { type: "agent", agentId: "a1" },
        body: "flag 格式确认一下？",
      })
      expect(sent).toHaveLength(0)
      // User post → urgent: immediate flush carrying the ask line.
      channels.post({
        channelId: dm.id,
        author: { type: "user" },
        body: "继续",
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("问询 Solver 1 · run-r1：flag 格式确认一下？")
      expect(sent[0]).toContain("用户：继续")
    } finally {
      close()
    }
  })

  test("stall watchdog: agent idle past the window flushes an urgent line", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running", updatedAt: ago(5) })
      seedAgent(db, "r1", {
        name: "Solver 1",
        status: "idle",
        updatedAt: ago(2), // idle for 2s ≥ 50ms window
      })
      const { digest, sent } = makeDigest(db, dir, { stallMs: 50 })
      digest.noteAgentIdle("r1")
      expect(sent).toHaveLength(0)
      await wait(100)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("⚠ agent 停滞：run-r1 Solver 1 idle 2s")
    } finally {
      close()
    }
  })

  test("stall watchdog: busy or closed runs never fire; close() cancels", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      // All agents running — nothing idle to report.
      seedRun(db, { id: "r1", status: "running", updatedAt: ago(5) })
      seedAgent(db, "r1", {
        name: "Solver 1",
        status: "running",
        updatedAt: ago(2),
      })
      // Run already closed.
      seedRun(db, { id: "r2", status: "closed", updatedAt: ago(5) })
      seedAgent(db, "r2", {
        name: "Solver 1",
        status: "idle",
        updatedAt: ago(2),
      })
      const { digest, sent } = makeDigest(db, dir, { stallMs: 50 })
      digest.noteAgentIdle("r1")
      digest.noteAgentIdle("r2")
      await wait(100)
      expect(sent).toHaveLength(0)

      // close() drops the pending timer (no late flush).
      seedRun(db, { id: "r3", status: "idle", updatedAt: ago(5) })
      seedAgent(db, "r3", {
        name: "Solver 1",
        status: "idle",
        updatedAt: ago(2),
      })
      digest.noteAgentIdle("r3")
      digest.close()
      await wait(100)
      expect(sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("stall watchdog: re-settling refreshes the window; paused never arms", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running", updatedAt: ago(5) })
      const { digest, sent } = makeDigest(db, dir, { stallMs: 60 })
      digest.noteAgentIdle("r1")
      await wait(30)
      // The agent settled again (updatedAt refreshed) — no stall at fire time.
      db.update(agents)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(agents.id, "ag-r1"))
        .run()
      digest.noteAgentIdle("r1") // re-arm with the fresh settle
      await wait(90)
      expect(sent).toHaveLength(0)

      const paused = makeDigest(db, dir, { stallMs: 50, paused: true })
      paused.digest.noteAgentIdle("r1")
      await wait(100)
      expect(paused.sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("every flush stores the digest as a recap message and advances the stable cursor", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(30) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.idle", runId: "r1" })
      await wait(80)
      digest.pushEmergency("队列不足：仅剩最后 1 项排队")
      expect(sent).toHaveLength(2)

      const channelId = dmId(db)
      const recaps = recapRows(db, channelId)
      expect(recaps).toHaveLength(2)
      expect(recaps[0]!.body).toBe(sent[0])
      expect(recaps[1]!.body).toBe(sent[1])
      expect(recaps[1]!.body).toContain("⚠ 队列不足")

      // Stable scheduler cursor sits ON the newest recap: nothing unread, so
      // the next quiet fire or snapshot drains empty.
      const cursor = db
        .select()
        .from(channelReads)
        .where(eq(channelReads.agentId, "scheduler"))
        .get()!
      expect(cursor.lastReadMsgId).toBe(
        Math.max(...recaps.map((row) => row.id))
      )
      expect(digest.snapshot().unreadCount).toBe(0)

      // And a no-op flush (nothing unread) sends nothing — the cursor
      // advanced past the flushed items, so a later flush does not re-deliver
      // them (the recap itself never re-flushes either).
      digest.pushEmergency("队列已恢复（用户手动控制）")
      digest.pushEmergency("队列已恢复2（用户手动控制）")
      expect(sent[2]).not.toContain("队列不足") // prior emergency not carried
      expect(sent[2]).not.toContain("run-r1") // prior run line not carried
      const after = recapRows(db, channelId)
      expect(after).toHaveLength(4) // 2 + 2 new flushes, no replay
    } finally {
      close()
    }
  })

  test("scheduler agent restart keeps the cursor: a fresh digest under a new orchestrator id does not re-deliver", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(30) })
      const first = makeDigest(db, dir, { silenceMs: 30 })
      first.digest.push({ type: "run.idle", runId: "r1" })
      await wait(80)
      expect(first.sent).toHaveLength(1)

      // New orchestrator agent id (scheduler restart): same channel, same
      // stable "scheduler" cursor key → no re-delivery of flushed history,
      // and the recap stays in the ledger for the new instance to read.
      const second = makeDigest(db, dir, {
        silenceMs: 30,
        orchestratorAgentId: "orch-2",
      })
      expect(second.digest.snapshot().unreadCount).toBe(0)
      expect(second.sent).toHaveLength(0)
      const channelId = dmId(db)
      expect(recapRows(db, channelId)).toHaveLength(1)
    } finally {
      close()
    }
  })

  test("snapshot exposes the live backlog and timers; close clears it", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running", updatedAt: ago(5) })
      seedAgent(db, "r1", {
        name: "Solver 1",
        status: "idle",
        updatedAt: ago(2),
      })
      const { digest, sent } = makeDigest(db, dir, {
        silenceMs: 5000,
        stallMs: 5000,
      })
      digest.push({ type: "run.started", runId: "r1" })
      digest.pushNotice("队列已暂停（用户手动控制）")
      digest.pushEmergency("启动失败：ch-1 — boom")
      digest.noteAgentIdle("r1")
      expect(sent).toHaveLength(1) // the emergency flushed the rest
      // Post-flush snapshot: everything drained, silence not armed.
      let snap = digest.snapshot()
      expect(snap.pending).toEqual([])
      expect(snap.notices).toEqual([])
      expect(snap.emergency).toEqual([])
      expect(snap.silence.armed).toBe(false)
      expect(snap.silence.flushAt).toBeNull()
      expect(snap.stallWatch).toEqual([
        { runId: "r1", dueAt: expect.any(Number) },
      ])

      // Re-arm the silent timer and re-check the armed snapshot.
      digest.push({ type: "run.idle", runId: "r1" })
      snap = digest.snapshot()
      expect(snap.pending).toEqual([{ runId: "r1", events: ["idle"] }])
      expect(snap.silence.armed).toBe(true)
      expect(snap.silence.flushAt).toBeGreaterThan(Date.now())

      digest.close()
      snap = digest.snapshot()
      // Persist-first: close clears TIMERS only — the unflushed backlog stays
      // in the channel (a fresh digest instance catch-up settles it; the
      // crash-recovery test covers that path).
      expect(snap.silence.armed).toBe(false)
      expect(snap.stallWatch).toEqual([])
      expect(snap.pending).toEqual([{ runId: "r1", events: ["idle"] }])
    } finally {
      close()
    }
  })

  test("delivery pause holds everything silently; resume flushes the backlog in one digest", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(30) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })

      digest.setDeliveryPaused(true)
      // Everything queues silently — even a timedOut (normally urgent) and a
      // queue emergency; no silence timer arms while paused.
      digest.push({ type: "run.started", runId: "r1" })
      digest.push({ type: "run.timedOut", runId: "r1", outcome: "idle" })
      digest.pushNotice("队列已暂停（用户手动控制）")
      digest.pushEmergency("队列不足：仅剩最后 1 项排队")
      await wait(80)
      expect(sent).toHaveLength(0)
      let snap = digest.snapshot()
      expect(snap.deliveryPaused).toBe(true)
      expect(snap.silence.armed).toBe(false)
      expect(snap.emergency.length).toBe(1)
      expect(snap.notices.length).toBe(1)

      // Resume: one catch-up digest carries run line + notice + ⚠ emergency.
      digest.setDeliveryPaused(false)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("timedOut")
      expect(sent[0]).toContain("队列已暂停")
      expect(sent[0]).toContain("⚠ 队列不足")
      snap = digest.snapshot()
      expect(snap.deliveryPaused).toBe(false)
      expect(snap.pending).toEqual([])
      expect(snap.emergency).toEqual([])
    } finally {
      close()
    }
  })

  test("delivery pause drops armed timers; resume catch-up re-arms stall checks for idle runs", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running", updatedAt: ago(5) })
      seedRun(db, { id: "r2", status: "idle", updatedAt: ago(5) })
      seedAgent(db, "r1", {
        name: "Solver 1",
        status: "idle",
        updatedAt: ago(2),
      })
      // r2 has NO settled agent (still streaming) → no catch-up arm.
      const { digest, sent } = makeDigest(db, dir, {
        silenceMs: 5000,
        stallMs: 5000,
      })

      // Armed pre-pause: a silence timer + a stall watch get dropped.
      digest.push({ type: "run.idle", runId: "r1" })
      digest.noteAgentIdle("r1")
      digest.setDeliveryPaused(true)
      let snap = digest.snapshot()
      expect(snap.silence.armed).toBe(false)
      expect(snap.stallWatch).toEqual([])
      // Paused stall fire would be a no-op anyway; nothing sends.
      await wait(30)
      expect(sent).toHaveLength(0)

      // Resume: backlog flush + catch-up re-arms r1 (idle agent), not r2.
      digest.setDeliveryPaused(false)
      expect(sent).toHaveLength(1)
      snap = digest.snapshot()
      expect(
        snap.stallWatch.map((entry: { runId: string }) => entry.runId).sort()
      ).toEqual(["r1"])
    } finally {
      close()
    }
  })

  test("close while paused never flushes; a fresh digest starts unpaused", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(30) })
      const held = makeDigest(db, dir, { silenceMs: 30 })
      held.digest.setDeliveryPaused(true)
      held.digest.push({ type: "run.idle", runId: "r1" })
      held.digest.close()
      await wait(80)
      expect(held.sent).toHaveLength(0)

      const fresh = makeDigest(db, dir, { silenceMs: 30 })
      expect(fresh.digest.snapshot().deliveryPaused).toBe(false)
    } finally {
      close()
    }
  })

  test("recap messages never trigger the digest policy (no re-flush loop)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "idle", updatedAt: ago(30) })
      const { digest, sent } = makeDigest(db, dir, { silenceMs: 30 })
      digest.push({ type: "run.idle", runId: "r1" })
      await wait(80)
      expect(sent).toHaveLength(1)
      // The recap row exists in the channel; onMessage skips kind=recap.
      const channelId = dmId(db)
      expect(recapRows(db, channelId)).toHaveLength(1)
      digest.onMessage({
        id: 999_999,
        channelId,
        kind: "recap",
        authorType: "system",
        authorAgentId: null,
        authorName: "system",
        body: "[调度事件摘要 now=00:00:00]",
        meta: {},
        createdAt: new Date().toISOString(),
        files: [],
      })
      await wait(60)
      expect(sent).toHaveLength(1) // nothing re-delivered
    } finally {
      close()
    }
  })
})
