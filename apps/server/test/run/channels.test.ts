import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, truncateSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { createLiveBus } from "../../src/agents/live"
import { createDatabase } from "../../src/db"
import {
  agents,
  channelFiles,
  channelMessages,
  channelReads,
  runs,
} from "../../src/db/schema"
import {
  FLUSH_INTERVAL_MS,
  SCHEDULER_READ_KEY,
  createChannelService,
  dmKey,
  formatSize,
  orchKey,
  parseChannelKey,
  renderMerged,
  teamKey,
  type ChannelService,
} from "../../src/run/channels"
import { createRunQueries } from "../../src/run/queries"
import { seedChallenge, seedEvent, seedRun } from "../helpers"

type Db = ReturnType<typeof setupDbLite>["db"]
type Dir = ReturnType<typeof setupDbLite>["dir"]

function setupDbLite() {
  const dir = `/tmp/aegisx-channels-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, dir, close: () => releaseLock() }
}

/** Recorded lifecycle: one entry per lifecycle.send (agentId, text). */
type SentEntry = { agentId: string; text: string }

function makeService(db: Db, dir: Dir) {
  const sent: SentEntry[] = []
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
    // Late-bound lifecycle getter (the service constructs before the
    // lifecycle — same contract as production).
    lifecycle: () =>
      ({
        send: async (agentId: string, text: string) => {
          sent.push({ agentId, text })
        },
      }) as never,
    now: () => new Date().toISOString(),
    workspaceAbs: (runId: string) => join(dir, "runs", runId, "workspace"),
  })
  return { channels, sent }
}

function seedSolver(
  db: Db,
  runId: string,
  id: string,
  overrides: Partial<typeof agents.$inferInsert> = {}
) {
  db.insert(agents)
    .values({
      id,
      runId,
      slot: overrides.slot ?? `solver-${id.slice(-1)}`,
      role: overrides.role ?? "solver",
      isEntry: overrides.isEntry ?? false,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: overrides.name,
      ...overrides,
    })
    .run()
}

/** The event's scheduler: an event-scope run + its orchestrator agent. */
function seedScheduler(db: Db, runId: string, id: string) {
  seedRun(db, {
    id: runId,
    scopeType: "event",
    challengeId: null,
    status: "running",
  })
  seedSolver(db, runId, id, {
    slot: "orchestrator",
    role: "orchestrator",
    isEntry: true,
    name: "Scheduler",
  })
}

/** Workspace file for attachment tests. */
function putWorkspaceFile(dir: Dir, runId: string, path: string, size: number) {
  const abs = join(dir, "runs", runId, "workspace", path)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, "x".repeat(size))
  return abs
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("derived keys (§二)", () => {
  test("key derivation + parseChannelKey accepts the three shapes, rejects garbage", () => {
    expect(teamKey("ch-1")).toBe("team:ch-1")
    expect(dmKey("a1")).toBe("dm:a1")
    expect(orchKey("evt-1")).toBe("orch:evt-1")
    expect(parseChannelKey("team:ch-1")).toEqual({ kind: "team", id: "ch-1" })
    expect(parseChannelKey("dm:a1")).toEqual({ kind: "dm", id: "a1" })
    expect(parseChannelKey("orch:evt-1")).toEqual({ kind: "orch", id: "evt-1" })
    // Colons INSIDE the id stay part of it (ids may contain anything).
    expect(parseChannelKey("dm:a:b")).toEqual({ kind: "dm", id: "a:b" })
    for (const bad of ["", "team", ":", "nonsense:x", "team:"]) {
      expect(parseChannelKey(bad)).toBeUndefined()
    }
  })
})

describe("channel trees (§2.2 / §9.1)", () => {
  test("run tree: #team + one DM per solver — derived, no seeding, canonical order", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1", isEntry: true })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels } = makeService(db, dir)
      // No ensure*, no rows — the tree derives from entities alone.
      const tree = channels.runChannelTree("r1")
      expect(tree.map((c) => c.key)).toEqual([
        teamKey("ch-1"),
        dmKey("a1"),
        dmKey("a2"),
      ])
      expect(tree.map((c) => c.kind)).toEqual(["team", "dm", "dm"])
      expect(tree[0]!.label).toBe("#team")
      expect(tree[0]!.sharedRunCount).toBe(1)
      expect(tree[1]!.agentId).toBe("a1")
      expect(tree[1]!.runId).toBe("r1")
      // UI trees pass a null reader → no per-reader unread.
      expect(tree.every((c) => c.unread === 0)).toBe(true)
      channels.close()
    } finally {
      close()
    }
  })

  test("challenge tree: exactly one #team, works with no run on the challenge", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const { channels } = makeService(db, dir)
      const tree = channels.challengeChannelTree("ch-1")
      expect(tree.map((c) => c.key)).toEqual([teamKey("ch-1")])
      expect(() => channels.challengeChannelTree("nope")).toThrow()
      channels.close()
    } finally {
      close()
    }
  })

  test("SDK list: solver = own team + own dm + orch; scheduler = every team + orch + every solver dm", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedChallenge(db, { id: "ch-2" })
      seedRun(db, { id: "r1", status: "running" })
      seedRun(db, { id: "r9", status: "running", challengeId: "ch-2" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r9", "b1", { slot: "solver-1" })
      seedScheduler(db, "rS", "s1")
      const { channels } = makeService(db, dir)

      expect(channels.agentChannels("a1").map((c) => c.key)).toEqual([
        teamKey("ch-1"),
        dmKey("a1"),
        orchKey("evt-1"),
      ])
      // The scheduler sees the whole event: both challenges' teams, orch,
      // and every solver's dm (challenge runs ordered by createdAt).
      expect(channels.agentChannels("s1").map((c) => c.key)).toEqual([
        teamKey("ch-1"),
        teamKey("ch-2"),
        orchKey("evt-1"),
        dmKey("a1"),
        dmKey("b1"),
      ])
      channels.close()
    } finally {
      close()
    }
  })
})

describe("write permissions — the 3 rules (§2.1)", () => {
  function setup() {
    const lite = setupDbLite()
    seedEvent(lite.db)
    seedChallenge(lite.db, { id: "ch-1" })
    seedChallenge(lite.db, { id: "ch-2" })
    seedRun(lite.db, { id: "r1", status: "running" })
    seedRun(lite.db, { id: "rX", status: "running", challengeId: "ch-2" })
    seedRun(lite.db, {
      id: "rY",
      status: "running",
      scopeType: "event",
      challengeId: null,
    })
    seedSolver(lite.db, "r1", "a1", { slot: "solver-1" })
    seedSolver(lite.db, "rX", "x1", { slot: "solver-1" })
    seedSolver(lite.db, "rY", "s1", {
      slot: "orchestrator",
      role: "orchestrator",
      name: "Scheduler",
    })
    return { ...lite, made: makeService(lite.db, lite.dir) }
  }

  test("team:<cid>: same-challenge solver, the event scheduler, user, system; foreign solvers rejected", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      const post = (author: Parameters<typeof channels.post>[0]["author"]) =>
        channels.post({
          channelKey: teamKey("ch-1"),
          author,
          body: "b",
        })
      // The event scheduler posts #team (its signed agent post IS the
      // announcement — #announce is gone).
      expect(() => post({ type: "agent", agentId: "s1" })).not.toThrow()
      expect(() => post({ type: "agent", agentId: "a1" })).not.toThrow()
      expect(() => post({ type: "user" })).not.toThrow()
      expect(() => post({ type: "system" })).not.toThrow()
      expect(() => post({ type: "agent", agentId: "x1" })).toThrow(/无权/)
      expect(() => post({ type: "agent", agentId: "ghost" })).toThrow(
        /not found/i
      )
      channels.close()
    } finally {
      close()
    }
  })

  test("dm:<aid>: the event scheduler, user, system — the target itself never writes", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      const post = (author: Parameters<typeof channels.post>[0]["author"]) =>
        channels.post({ channelKey: dmKey("a1"), author, body: "b" })
      expect(() => post({ type: "agent", agentId: "s1" })).not.toThrow()
      expect(() => post({ type: "user" })).not.toThrow()
      expect(() => post({ type: "system" })).not.toThrow()
      // The target agent cannot write its own DM.
      expect(() => post({ type: "agent", agentId: "a1" })).toThrow(/自己的 DM/)
      // A random solver is not the scheduler.
      expect(() => post({ type: "agent", agentId: "x1" })).toThrow(/调度者/)
      channels.close()
    } finally {
      close()
    }
  })

  test("orch:<eid>: this event's solvers, user, system — the scheduler never writes", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      const post = (author: Parameters<typeof channels.post>[0]["author"]) =>
        channels.post({ channelKey: orchKey("evt-1"), author, body: "b" })
      expect(() => post({ type: "agent", agentId: "a1" })).not.toThrow()
      expect(() => post({ type: "agent", agentId: "x1" })).not.toThrow()
      expect(() => post({ type: "user" })).not.toThrow()
      expect(() => post({ type: "system" })).not.toThrow()
      // The scheduler agent RECEIVES orch; it never writes it.
      expect(() => post({ type: "agent", agentId: "s1" })).toThrow(/调度者不写/)
      channels.close()
    } finally {
      close()
    }
  })

  test("agent posts carry the run-suffix author snapshot + stamped runId meta (§11.4)", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      const message = channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "finding",
      })
      expect(message.authorName).toBe("solver-1 · run-r1")
      expect(message.meta.runId).toBe("r1")
      const sys = channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "system" },
        body: "sys",
      })
      expect(sys.authorName).toBe("system")
      expect(sys.meta.runId).toBeUndefined()
      channels.close()
    } finally {
      close()
    }
  })
})

describe("urgent delivery matrix (§3.2 / §3.3)", () => {
  test("team urgent: one steer per live solver across EVERY live run on the challenge; closed runs store only", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedRun(db, { id: "r2", status: "idle" })
      seedRun(db, { id: "r3", status: "closed" })
      seedSolver(db, "r1", "a1", { slot: "solver-1", name: "S1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2", name: "S2" })
      seedSolver(db, "r2", "b1", { slot: "solver-1", name: "S1" })
      seedSolver(db, "r3", "c1", { slot: "solver-1" })
      const { channels, sent } = makeService(db, dir)

      // a1 posts urgent — a1's own post is never a1's unread; recipients:
      // a2 (same run) + b1 (the OTHER live run). c1's run is closed → store.
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "cross-run finding",
        urgent: true,
      })
      await settle()
      expect(sent.map((s) => s.agentId).sort()).toEqual(["a2", "b1"])
      for (const s of sent) {
        expect(s.text).toContain("cross-run finding")
        // Unambiguous attribution across runs: run trace in the author line.
        expect(s.text).toContain("run-r1")
      }
      // The closed-run member sees the message as UNREAD (store-only).
      expect(
        channels.agentChannels("c1").find((c) => c.kind === "team")!.unread
      ).toBe(1)
      channels.close()
    } finally {
      close()
    }
  })

  test("dm urgent: cold-wakes a closed run and delivers ONLY the dm (red line)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "closed" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)

      // Stored team backlog for the closed run — never swept on cold wake.
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "user" },
        body: "stored only",
      })
      expect(sent).toHaveLength(0)

      channels.post({
        channelKey: dmKey("a2"),
        author: { type: "user" },
        body: "wake up",
        urgent: true,
      })
      await settle()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.agentId).toBe("a2")
      expect(sent[0]!.text).toContain("wake up")
      // The stored #team backlog stays unread — restore touches only the
      // triggered agent, and only its dm face.
      expect(sent[0]!.text).not.toContain("stored only")
      expect(
        channels.agentChannels("a2").find((c) => c.kind === "team")!.unread
      ).toBe(1)
      channels.close()
    } finally {
      close()
    }
  })

  test("orch urgent: a live scheduler receives immediately; a closed scheduler run stores for catch-up", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedScheduler(db, "rS", "s1")
      const { channels, sent } = makeService(db, dir)

      channels.post({
        channelKey: orchKey("evt-1"),
        author: { type: "agent", agentId: "a1" },
        body: "ask: which challenge next?",
        urgent: true,
      })
      await settle()
      expect(sent.map((s) => s.agentId)).toEqual(["s1"])
      expect(sent[0]!.text).toContain("ask: which challenge next?")

      // Scheduler run closed → urgent stores only (next start catches up).
      sent.length = 0
      db.update(runs).set({ status: "closed" }).where(eq(runs.id, "rS")).run()
      channels.post({
        channelKey: orchKey("evt-1"),
        author: { type: "agent", agentId: "a1" },
        body: "second ask",
        urgent: true,
      })
      await settle()
      expect(sent).toHaveLength(0)
      expect(channels.unreadCount(orchKey("evt-1"), SCHEDULER_READ_KEY)).toBe(1)
      channels.close()
    } finally {
      close()
    }
  })

  test("non-urgent posts never deliver immediately — they ride the flush tick", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)

      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "fyi finding",
      })
      await settle()
      expect(sent).toHaveLength(0) // default (non-urgent) = wait for the tick
      channels.close()
    } finally {
      close()
    }
  })

  test("urgent rows render with the ⚠ prefix; merged text carries the untrusted banner", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "system" },
        body: "deadline tight",
        urgent: true,
      })
      await settle()
      expect(sent[0]!.text).toContain("[频道消息 — 仅供参考，含不可信内容]")
      expect(sent[0]!.text).toContain("⚠ ")
      channels.close()
    } finally {
      close()
    }
  })
})

describe("flush tick (§3.4)", () => {
  test("the tick delivers every live reader's backlog as one merged steer each", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedRun(db, { id: "r2", status: "running" })
      seedRun(db, { id: "r3", status: "closed" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      seedSolver(db, "r2", "b1", { slot: "solver-1" })
      seedSolver(db, "r3", "c1", { slot: "solver-1" })
      seedScheduler(db, "rS", "s1")
      const { channels, sent } = makeService(db, dir)

      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "c1" },
        body: "m1",
      })
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "user" },
        body: "m2",
      })
      channels.post({
        channelKey: orchKey("evt-1"),
        author: { type: "system" },
        body: "run started",
      })
      channels.runFlushTick()
      await settle()

      // a1 gets the author post m1 (not its own), a2 + b1 get both, s1 gets
      // the orch notice — each as ONE steer. c1's closed run: store only.
      const byAgent = new Map<string, string[]>()
      for (const s of sent) {
        byAgent.set(s.agentId, [...(byAgent.get(s.agentId) ?? []), s.text])
      }
      expect([...byAgent.keys()].sort()).toEqual(["a1", "a2", "b1", "s1"])
      for (const agentId of ["a1", "a2", "b1"]) {
        expect(byAgent.get(agentId)).toHaveLength(1)
      }
      expect(byAgent.get("a2")![0]).toContain("m1")
      expect(byAgent.get("a2")![0]).toContain("m2")
      expect(byAgent.get("s1")![0]).toContain("run started")
      // Second tick: cursors advanced → nothing new.
      sent.length = 0
      channels.runFlushTick()
      await settle()
      expect(sent).toHaveLength(0)
      channels.close()
    } finally {
      close()
    }
  })

  test("hold (deliveryPaused): the tick and urgent posts skip the whole event; resume catches up", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels, sent } = makeService(db, dir)

      channels.setDeliveryPaused("evt-1", true)
      expect(channels.isDeliveryPaused("evt-1")).toBe(true)
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "system" },
        body: "paused post",
        urgent: true,
      })
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "system" },
        body: "paused tick post",
      })
      await settle()
      expect(sent).toHaveLength(0) // urgent skipped under hold
      channels.runFlushTick()
      await settle()
      expect(sent).toHaveLength(0) // tick skipped under hold

      // Resume: the stored backlog rides the next tick.
      channels.setDeliveryPaused("evt-1", false)
      channels.runFlushTick()
      await settle()
      expect(sent.map((s) => s.agentId)).toEqual(["a1"])
      expect(sent[0]!.text).toContain("paused post")
      expect(sent[0]!.text).toContain("paused tick post")
      channels.close()
    } finally {
      close()
    }
  })

  test("inboxSnapshot: orch key + stable-cursor unread + tick state + hold", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      const { channels } = makeService(db, dir)
      const snap = channels.inboxSnapshot("evt-1")
      expect(snap.channelKey).toBe(orchKey("evt-1"))
      expect(snap.unreadCount).toBe(0)
      expect(snap.deliveryPaused).toBe(false)
      // nextFlushAt exposed for the UI state head; a tick re-arms it.
      expect(snap.nextFlushAt).toBeGreaterThanOrEqual(Date.now())
      channels.runFlushTick()
      const after = channels.inboxSnapshot("evt-1")
      expect(after.nextFlushAt).toBeGreaterThanOrEqual(
        Date.now() + FLUSH_INTERVAL_MS - 1_000
      )
      channels.setDeliveryPaused("evt-1", true)
      expect(channels.inboxSnapshot("evt-1").deliveryPaused).toBe(true)
      channels.close()
    } finally {
      close()
    }
  })
})

describe("read cursors — three progression points (§3.5)", () => {
  test("self-post advances the author's cursor; SDK read and deliver advance too", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)

      // 1. Self-post: author cursor lands on the message id.
      const own = channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "self",
      })
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(own.id)

      // 2. SDK read (pull = consume): a user post lands, a1 reads it.
      const hello = channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "user" },
        body: "hello",
      })
      const read = channels.readForAgent("a1", "#team")
      expect(read.items.map((m) => m.body)).toContain("hello")
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(
        read.items.at(-1)!.id
      )
      expect(read.channel.key).toBe(teamKey("ch-1"))

      // 3. Deliver after the pull: nothing new → no steer.
      sent.length = 0
      await channels.deliverAgentAwaited("a1")
      expect(sent).toHaveLength(0)

      // a2 has not read: unread counts exclude a2's own... (a2 authored
      // nothing) — one unread (hello; a1's own post is a1-read but still
      // unread for a2's cursor... wait: own-post filter only applies to the
      // author. a2 sees BOTH messages).
      expect(channels.unreadCount(teamKey("ch-1"), "a2")).toBe(2)
      await channels.deliverAgentAwaited("a2")
      expect(sent.map((s) => s.agentId)).toEqual(["a2"])
      expect(channels.readCursor(teamKey("ch-1"), "a2")).toBe(hello.id)
      channels.close()
    } finally {
      close()
    }
  })

  test("onboarding deliver: a fresh solver (cursor 0) sweeps the whole #team history once (§11.3)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "closed" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels, sent } = makeService(db, dir)
      // Prior knowledge sitting in #team (run closed → stored, not delivered).
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "prior finding: heap overflow in edit()",
      })
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "system" },
        body: "remote libc 2.35 — trust the target",
      })

      // A second run's fresh solver: cursor 0 → one deliver sweeps BOTH.
      seedRun(db, { id: "r2", status: "running" })
      seedSolver(db, "r2", "b1", { slot: "solver-1" })
      await channels.deliverAgentAwaited("b1")
      expect(sent.map((s) => s.agentId)).toEqual(["b1"])
      expect(sent[0]!.text).toContain("prior finding: heap overflow in edit()")
      expect(sent[0]!.text).toContain("remote libc 2.35 — trust the target")
      // Exactly once: a re-deliver finds nothing new.
      sent.length = 0
      await channels.deliverAgentAwaited("b1")
      expect(sent).toHaveLength(0)
      channels.close()
    } finally {
      close()
    }
  })

  test("SDK read selectors: #team/team/orch/raw key + visibility (§2.2)", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedChallenge(db, { id: "ch-2" })
      seedRun(db, { id: "r1", status: "running" })
      seedRun(db, { id: "rX", status: "running", challengeId: "ch-2" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "rX", "x1", { slot: "solver-1" })
      seedScheduler(db, "rS", "s1")
      const { channels } = makeService(db, dir)

      expect(channels.readForAgent("a1", "#team").channel.key).toBe(
        teamKey("ch-1")
      )
      expect(channels.readForAgent("a1", "team").channel.key).toBe(
        teamKey("ch-1")
      )
      expect(channels.readForAgent("a1", "orch").channel.key).toBe(
        orchKey("evt-1")
      )
      expect(channels.readForAgent("a1", dmKey("a1")).channel.key).toBe(
        dmKey("a1")
      )
      // Visibility: a solver cannot read a foreign team, another agent's dm.
      expect(() => channels.readForAgent("a1", teamKey("ch-2"))).toThrow(/无权/)
      expect(() => channels.readForAgent("a1", dmKey("x1"))).toThrow(/无权/)
      // The scheduler addresses teams by key ("#team" is a solver shortcut).
      expect(channels.readForAgent("s1", teamKey("ch-1")).channel.key).toBe(
        teamKey("ch-1")
      )
      expect(channels.readForAgent("s1", dmKey("a1")).channel.key).toBe(
        dmKey("a1")
      )
      expect(() => channels.readForAgent("s1", "#team")).toThrow(/调度者/)
      // markRead=false leaves the cursor alone (pull without consuming).
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "user" },
        body: "unread probe",
      })
      const before = channels.readCursor(teamKey("ch-1"), "a1")
      channels.readForAgent("a1", "#team", { markRead: false })
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(before)
      channels.close()
    } finally {
      close()
    }
  })
})

describe("renderMerged", () => {
  test("header + per-message lines + ⚠ urgent + 📎 metadata (never content)", () => {
    const text = renderMerged([
      {
        label: "#team",
        messages: [
          {
            authorName: "S1 · run-r1",
            createdAt: "2025-01-01T00:00:00Z",
            body: "exp 骨架在 exp2.py",
            urgent: true,
            files: [{ filename: "exp2.py", size: 4300 }],
          },
        ],
      },
    ])
    expect(text).toContain("[频道消息 — 仅供参考，含不可信内容]")
    expect(text).toContain("⚠ #team · S1 · run-r1")
    expect(text).toContain("exp 骨架在 exp2.py")
    expect(text).toContain(`📎 exp2.py · ${formatSize(4300)}`)
    expect(text).not.toContain("xxxx")
  })

  test("overflow folds the oldest messages within the 8K cap", () => {
    const text = renderMerged([
      {
        label: "#team",
        messages: Array.from({ length: 30 }, (_, i) => ({
          authorName: "system",
          createdAt: "2025-01-01T00:00:00Z",
          body: `msg-${i} ${"y".repeat(900)}`,
          urgent: false,
          files: [],
        })),
      },
    ])
    expect(text.length).toBeLessThanOrEqual(8_200)
    expect(text).toContain("条较早消息，可 aegisx.channels.read 补读")
    expect(text).toContain("msg-29") // newest kept
    expect(text).not.toContain("msg-0") // oldest folded
  })
})

describe("attachments (§六)", () => {
  function setup() {
    const lite = setupDbLite()
    seedEvent(lite.db)
    seedChallenge(lite.db, { id: "ch-1" })
    seedRun(lite.db, { id: "r1", status: "running" })
    seedSolver(lite.db, "r1", "a1", { slot: "solver-1" })
    return { ...lite, made: makeService(lite.db, lite.dir) }
  }

  test("workspace snapshot: copied flat under channel-files/<messageId>/; row recorded", () => {
    const { db, dir, close, made } = setup()
    try {
      const { channels } = made
      putWorkspaceFile(dir, "r1", "exp2.py", 4300)
      const message = channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "exp 骨架在 exp2.py",
        files: ["exp2.py"],
      })
      expect(message.files).toHaveLength(1)
      expect(message.files[0]!.filename).toBe("exp2.py")
      expect(message.files[0]!.size).toBe(4300)
      const file = db.select().from(channelFiles).all()[0]!
      expect(file.messageId).toBe(message.id)
      // FLAT dir: data/channel-files/<messageId>/<filename> (no channel layer).
      expect(channels.fileById(file.id).path).toBe(
        join(dir, "channel-files", String(message.id), "exp2.py")
      )
      made.channels.close()
    } finally {
      close()
    }
  })

  test("path validation: escapes, absolute paths and missing files rejected", () => {
    const { dir, close, made } = setup()
    try {
      const { channels } = made
      putWorkspaceFile(dir, "r1", "poc.py", 100)
      const post = (files: string[]) =>
        channels.post({
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "b",
          files,
        })
      expect(() => post(["../../etc/passwd"])).toThrow(/越界/)
      expect(() => post(["/etc/passwd"])).toThrow(/不合法/)
      expect(() => post(["missing.py"])).toThrow(/不存在/)
      expect(() => post(["poc.py"])).not.toThrow()
      made.channels.close()
    } finally {
      close()
    }
  })

  test("caps: 8 files per message, 16K body chars, 64MB per file", () => {
    const { dir, close, made } = setup()
    try {
      const { channels } = made
      for (let i = 0; i < 9; i += 1) putWorkspaceFile(dir, "r1", `f${i}`, 1)
      expect(() =>
        channels.post({
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "b",
          files: Array.from({ length: 9 }, (_, i) => `f${i}`),
        })
      ).toThrow(/最多 8 个附件/)
      expect(() =>
        channels.post({
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "x".repeat(16_001),
        })
      ).toThrow(/16_?000|16,000|16K/)
      // Sparse 65MB file: statSync sees the size, no data written.
      const big = putWorkspaceFile(dir, "r1", "big.bin", 1)
      truncateSync(big, 65 * 1024 * 1024)
      expect(() =>
        channels.post({
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "b",
          files: ["big.bin"],
        })
      ).toThrow(/64MB/)
      // Workspace attachments are agent-only.
      expect(() =>
        channels.post({
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "b",
          files: ["poc.py"],
        })
      ).toThrow(/只能由 agent/)
      made.channels.close()
    } finally {
      close()
    }
  })

  test("user multipart upload: urgent defaults TRUE; blobs stored; stream failure rolls the whole message back", async () => {
    const { db, dir, close, made } = setup()
    try {
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = made
      const message = await channels.postWithUpload({
        channelKey: teamKey("ch-1"),
        author: { type: "user" },
        body: "with attachment",
        uploads: [
          {
            filename: "notes.txt",
            size: 5,
            stream: async () => new Uint8Array([104, 101, 108, 108, 111]),
          },
        ],
      })
      expect(message.files).toHaveLength(1)
      const { row, path } = channels.fileById(message.files[0]!.id)
      expect(row.size).toBe(5)
      expect(path).toBe(
        join(dir, "channel-files", String(message.id), "notes.txt")
      )
      // urgent default true on the user path → both live solvers got the
      // steer (the author is the user — no own-post exclusion).
      await settle()
      expect(sent.map((s) => s.agentId).sort()).toEqual(["a1", "a2"])
      expect(sent[0]!.text).toContain("📎 notes.txt")

      // Rollback: a failing second upload drops files AND the message row.
      const before = db.select().from(channelMessages).all().length
      await expect(
        channels.postWithUpload({
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "broken",
          uploads: [
            {
              filename: "ok.txt",
              size: 1,
              stream: async () => new Uint8Array([1]),
            },
            {
              filename: "boom.txt",
              size: 1,
              stream: async () => {
                throw new Error("disk full")
              },
            },
          ],
        })
      ).rejects.toThrow(/disk full/)
      expect(db.select().from(channelMessages).all().length).toBe(before)
      expect(
        db
          .select()
          .from(channelFiles)
          .all()
          .filter((f) => f.filename === "ok.txt")
      ).toHaveLength(0)
      made.channels.close()
    } finally {
      close()
    }
  })
})

describe("timeline pagination (§9.1)", () => {
  test("listMessages: newest window above the `after` floor; hasMore + incremental pulls", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      const { channels } = makeService(db, dir)
      for (let i = 1; i <= 5; i += 1) {
        channels.post({
          channelKey: teamKey("ch-1"),
          author: { type: "system" },
          body: `m${i}`,
        })
      }
      // The window is always the newest `limit` messages above the floor.
      const page1 = channels.listMessages(teamKey("ch-1"), { limit: 2 })
      expect(page1.items.map((m) => m.body)).toEqual(["m4", "m5"])
      expect(page1.hasMore).toBe(true)
      expect(page1.nextAfter).toBe(5)
      // Widening the limit exposes the older tail (ascending order kept).
      const full = channels.listMessages(teamKey("ch-1"), { limit: 10 })
      expect(full.items.map((m) => m.body)).toEqual([
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
      ])
      expect(full.hasMore).toBe(false)
      // Incremental pull above the cursor: nothing new.
      const tail = channels.listMessages(teamKey("ch-1"), { after: 5 })
      expect(tail.items).toHaveLength(0)
      expect(tail.hasMore).toBe(false)
      expect(() => channels.listMessages("garbage")).toThrow(/非法频道键/)
      channels.close()
    } finally {
      close()
    }
  })
})

describe("explicit cleanup (§八)", () => {
  test("run deletion removes its agents' dm data; #team knowledge survives", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels } = makeService(db, dir)
      channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "knowledge",
      })
      channels.post({
        channelKey: dmKey("a1"),
        author: { type: "user" },
        body: "dm note",
      })
      channels.markRead(dmKey("a1"), "a1", 99)

      channels.cleanupRunChannels("r1")
      expect(
        db
          .select()
          .from(channelMessages)
          .where(eq(channelMessages.channelKey, dmKey("a1")))
          .all()
      ).toHaveLength(0)
      expect(
        db
          .select()
          .from(channelReads)
          .where(eq(channelReads.channelKey, dmKey("a1")))
          .all()
      ).toHaveLength(0)
      // The #team knowledge base survives single-run deletion.
      expect(
        db
          .select()
          .from(channelMessages)
          .where(eq(channelMessages.channelKey, teamKey("ch-1")))
          .all()
      ).toHaveLength(1)
      channels.close()
    } finally {
      close()
    }
  })

  test("event deletion sweeps orch + every team + every dm, with attachment dirs", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels } = makeService(db, dir)
      putWorkspaceFile(dir, "r1", "dump.bin", 10)
      const withFile = channels.post({
        channelKey: teamKey("ch-1"),
        author: { type: "agent", agentId: "a1" },
        body: "dump attached",
        files: ["dump.bin"],
      })
      channels.post({
        channelKey: orchKey("evt-1"),
        author: { type: "system" },
        body: "evt",
      })
      channels.post({
        channelKey: dmKey("a1"),
        author: { type: "user" },
        body: "dm",
      })
      const fileDir = join(dir, "channel-files", String(withFile.id))

      channels.cleanupEventChannels("evt-1")
      expect(db.select().from(channelMessages).all()).toHaveLength(0)
      expect(db.select().from(channelReads).all()).toHaveLength(0)
      expect(db.select().from(channelFiles).all()).toHaveLength(0)
      expect(existsSync(fileDir)).toBe(false)
      channels.close()
    } finally {
      close()
    }
  })
})
