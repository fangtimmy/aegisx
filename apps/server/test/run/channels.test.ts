import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"

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
  createChannelService,
  formatSize,
  type ChannelService,
} from "../../src/run/channels"
import { createRunQueries } from "../../src/run/queries"
import { flatSettings, seedChallenge, seedEvent, seedRun } from "../helpers"

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
  const schedulerDmMessages: string[] = []
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
  const channels = createChannelService({
    db,
    dataDir: dir,
    bus: createLiveBus(),
    queries,
    lifecycle: {
      send: async (agentId: string, text: string) => {
        sent.push({ agentId, text })
      },
    } as never,
    now: () => new Date().toISOString(),
    workspaceAbs: (runId: string) => join(dir, "runs", runId, "workspace"),
    onSchedulerDmMessage: (_eventId, message) => {
      schedulerDmMessages.push(message.body)
    },
  })
  return { channels, sent, schedulerDmMessages }
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
      role: "solver",
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

/** Workspace file for attachment tests. */
function putWorkspaceFile(dir: Dir, runId: string, path: string, size: number) {
  const abs = join(dir, "runs", runId, "workspace", path)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, "x".repeat(size))
  return abs
}

describe("channel tree", () => {
  test("run channels: #announce + #team + per-solver DM, canonical order; scheduler DM is event-scoped", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1", isEntry: true })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      channels.ensureAgentDm("r1", "a1")
      channels.ensureAgentDm("r1", "a2")
      const tree = channels.runChannelTree("r1")
      expect(tree.map((c) => c.kind)).toEqual(["announce", "team", "dm", "dm"])
      // Idempotent.
      channels.ensureRunChannels("r1")
      channels.ensureAgentDm("r1", "a1")
      expect(channels.runChannelTree("r1")).toHaveLength(4)

      const scheduler = channels.ensureSchedulerDm("evt-1", "sched-1")
      expect(scheduler.scopeType).toBe("event")
      // Re-attach re-stamps the target (scheduler restart).
      channels.ensureSchedulerDm("evt-1", "sched-2")
      expect(channels.schedulerDm("evt-1")?.targetAgentId).toBe("sched-2")
    } finally {
      close()
    }
  })
})

describe("deliver engine (docs/im-channels.md §2.3/§2.4)", () => {
  test("live run: #team post steers every live member ONCE with the merged text; own posts excluded", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1", name: "Solver 1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2", name: "Solver 2" })
      const { channels, sent } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      channels.ensureAgentDm("r1", "a1")
      channels.ensureAgentDm("r1", "a2")
      const team = channels.runChannelTree("r1").find((c) => c.kind === "team")!

      // a1 posts to #team — a1's own post is never a1's unread.
      channels.post({
        channelId: team.id,
        author: { type: "agent", agentId: "a1" },
        body: "确认 off-by-null，exp 骨架在 exp2.py",
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.agentId).toBe("a2")
      expect(sent[0]!.text).toContain("[频道消息 — 仅供参考，含不可信内容]")
      expect(sent[0]!.text).toContain("#team · Solver 1 ·")
      expect(sent[0]!.text).toContain("确认 off-by-null")

      // A system post reaches BOTH solvers (merged, one steer each).
      sent.length = 0
      channels.post({
        channelId: team.id,
        author: { type: "system" },
        body: "⚠ deadline 剩 9m",
      })
      expect(sent).toHaveLength(2)
      expect(new Set(sent.map((s) => s.agentId))).toEqual(new Set(["a1", "a2"]))
      expect(sent[0]!.text).toContain("⚠ deadline 剩 9m")
      expect(sent[1]!.text).not.toContain("确认 off-by-null") // read cursor moved
    } finally {
      close()
    }
  })

  test("closed run: #team posts are stored but NOT delivered; DM posts still wake the target (cold-restore red line)", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "closed" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      channels.ensureAgentDm("r1", "a1")
      channels.ensureAgentDm("r1", "a2")
      const tree = channels.runChannelTree("r1")
      const team = tree.find((c) => c.kind === "team")!
      const dm = tree.find((c) => c.kind === "dm" && c.targetAgentId === "a2")!

      channels.post({
        channelId: team.id,
        author: { type: "user" },
        body: "stored only",
      })
      expect(sent).toHaveLength(0) // closed: store only
      const rows = db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.channelId, team.id))
        .all()
      expect(rows).toHaveLength(1)

      // DM to a closed run still delivers (lifecycle.send → onResume).
      channels.post({
        channelId: dm.id,
        author: { type: "user" },
        body: "wake up",
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.agentId).toBe("a2")
      // The DM steer for a closed run carries ONLY the DM message — the
      // stored #team backlog stays unread until the run is live again
      // ("restore touches only the triggered agent").
      expect(sent[0]!.text).toContain("wake up")
      expect(sent[0]!.text).not.toContain("stored only")
    } finally {
      close()
    }
  })

  test("read cursors advance on the three points: deliver, SDK read, self-post", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels, sent } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      const tree = channels.runChannelTree("r1")
      const team = tree.find((c) => c.kind === "team")!

      // 1. Self-post advances the poster's cursor (not the poster's unread).
      channels.post({
        channelId: team.id,
        author: { type: "agent", agentId: "a1" },
        body: "self",
      })
      expect(sent).toHaveLength(0)

      // 2. SDK read (pull = read): a user post lands, a1 reads it.
      channels.post({
        channelId: team.id,
        author: { type: "user" },
        body: "hello",
      })
      expect(sent).toHaveLength(1)
      const read = channels.readForAgent("a1", "#team")
      expect(read.items.map((m) => m.body)).toContain("hello")
      // The read marked BOTH messages read (self-post included via cursor).
      const row = db
        .select()
        .from(channelReads)
        .where(
          and(
            eq(channelReads.channelId, team.id),
            eq(channelReads.agentId, "a1")
          )
        )
        .get()
      expect(row!.lastReadMsgId).toBe(read.items.at(-1)!.id)

      // 3. Deliver after the pull: nothing new → no steer.
      sent.length = 0
      channels.deliver("a1")
      expect(sent).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("merged render carries 📎 metadata lines (never file content)", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1", name: "Solver 1" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      putWorkspaceFile(dir, "r1", "exp2.py", 4300)
      const team = channels.runChannelTree("r1").find((c) => c.kind === "team")!
      channels.post({
        channelId: team.id,
        author: { type: "agent", agentId: "a1" },
        body: "exp 骨架在 exp2.py",
        files: ["exp2.py"],
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain(`📎 exp2.py · ${formatSize(4300)}`)
      expect(sent[0]!.text).not.toContain("xxxx") // content not injected
      // Attachment row + snapshot file recorded.
      const file = db.select().from(channelFiles).all()[0]!
      expect(file.filename).toBe("exp2.py")
      expect(file.size).toBe(4300)
    } finally {
      close()
    }
  })

  test("attachment path validation: escape and absolute paths rejected; snapshot copied", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      const team = channels.runChannelTree("r1").find((c) => c.kind === "team")!
      putWorkspaceFile(dir, "r1", "poc.py", 100)
      const post = (files: string[]) =>
        channels.post({
          channelId: team.id,
          author: { type: "agent", agentId: "a1" },
          body: "b",
          files,
        })
      expect(() => post(["../../etc/passwd"])).toThrow(/越界/)
      expect(() => post(["/etc/passwd"])).toThrow(/不合法/)
      expect(() => post(["missing.py"])).toThrow(/不存在/)
      // A valid workspace path copies fine.
      expect(() => post(["poc.py"])).not.toThrow()
    } finally {
      close()
    }
  })

  test("overflow folding: a restored run's backlog renders newest-first within the 8K cap", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      // Closed: #team posts are stored, not delivered (the red line) — this is
      // exactly the accumulation window the merged render exists for.
      seedRun(db, { id: "r1", status: "closed" })
      seedSolver(db, "r1", "a2", { slot: "solver-2" })
      const { channels, sent } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      const team = channels.runChannelTree("r1").find((c) => c.kind === "team")!
      for (let i = 0; i < 30; i += 1) {
        channels.post({
          channelId: team.id,
          author: { type: "system" },
          body: `msg-${i} ${"y".repeat(900)}`,
        })
      }
      expect(sent).toHaveLength(0)
      // Run goes live again; the next post's deliver sweeps the backlog as
      // ONE merged steer (not N turns) with oldest-folding under the 8K cap.
      db.update(runs).set({ status: "running" }).where(eq(runs.id, "r1")).run()
      channels.post({
        channelId: team.id,
        author: { type: "system" },
        body: "msg-30 trigger",
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text.length).toBeLessThanOrEqual(8200)
      expect(sent[0]!.text).toContain(
        "条较早消息，可 aegisx.channels.read 补读"
      )
      expect(sent[0]!.text).toContain("msg-30 trigger")
    } finally {
      close()
    }
  })
})

describe("user multipart upload + downloads", () => {
  test("postWithUpload stores blobs as attachments; fileById resolves for download", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels } = makeService(db, dir)
      channels.ensureRunChannels("r1")
      const team = channels.runChannelTree("r1").find((c) => c.kind === "team")!
      const message = await channels.postWithUpload({
        channelId: team.id,
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
      expect(message.files[0]!.filename).toBe("notes.txt")
      const { row, path } = channels.fileById(message.files[0]!.id)
      expect(row.size).toBe(5)
      expect(path).toContain(join(dir, "channel-files", team.id))
    } finally {
      close()
    }
  })
})

describe("scheduler DM writes", () => {
  test("event-scope DM posts flow to the digest policy hook; solver channels.list includes it", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedRun(db, { id: "r1", status: "running" })
      seedSolver(db, "r1", "a1", { slot: "solver-1" })
      const { channels, schedulerDmMessages } = makeService(db, dir)
      const dm = channels.ensureSchedulerDm("evt-1", "sched-1")
      channels.post({
        channelId: dm.id,
        author: { type: "user" },
        body: "hello scheduler",
      })
      expect(schedulerDmMessages).toEqual(["hello scheduler"])

      // Solver visibility: team + announce + own DM + the scheduler DM.
      channels.ensureRunChannels("r1")
      channels.ensureAgentDm("r1", "a1")
      const visible = channels.agentChannels("a1").map((c) => c.kind)
      expect(visible).toEqual(["announce", "team", "dm", "dm"])
    } finally {
      close()
    }
  })
})
