import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, truncateSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { formatSize } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import { createDatabase } from "../../src/db"
import {
  agents,
  channelMessages,
  channelReads,
  schedulerConfig,
} from "../../src/db/schema"
import { DEFAULT_CHANNEL_DELIVERY_TEMPLATE } from "../../src/orchestration/prompt-defaults"
import {
  SCHEDULER_READ_KEY,
  createChannelService,
  dmKey,
  orchKey,
  parseChannelKey,
  renderMerged,
  teamKey,
  type ChannelService,
} from "../../src/run/channels"
import { fmtClock, renderDelivery } from "../../src/run/channels-render"
import type { Clock } from "../../src/run/clock"
import { createLiveBus, type LiveBus } from "../../src/run/host/live"
import {
  agentPrincipal,
  now,
  seedChallenge,
  seedEvent,
  SYSTEM,
  USER,
} from "../helpers"

type Db = ReturnType<typeof setupDbLite>["db"]
type Dir = ReturnType<typeof setupDbLite>["dir"]

function setupDbLite() {
  const dir = `/tmp/aegisx-channels-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  return { db, dir, close: () => releaseLock() }
}

/** The urgent-team policy defaults ON (every #team post delivers
 * immediately). Tests of the generic flush-tick / cursor mechanics pin it
 * OFF so non-urgent really rides the tick. */
function disableUrgentTeam(db: Db, eventId = "evt-1") {
  db.insert(schedulerConfig)
    .values({
      eventId,
      urgentTeamMessages: false,
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
}

/** Recorded sends: one entry per runtime send (agentId, text). */
type SentEntry = { agentId: string; text: string }

function makeService(
  db: Db,
  dir: Dir,
  deps: { bus?: LiveBus; clock?: Clock } = {}
) {
  const sent: SentEntry[] = []
  const inbox: Array<{
    eventId: string
    kind: "orch" | "dm"
    authorType: "agent" | "user"
    authorAgentId?: string
    body: string
  }> = []
  const bus = deps.bus ?? createLiveBus()
  const channels: ChannelService = createChannelService({
    db,
    dataDir: dir,
    bus,
    // Recorded runtime send (the service wires the same seam through its
    // agents' runtimes).
    send: async (agentId: string, text: string) => {
      sent.push({ agentId, text })
      return { delivered: true, via: "fresh" as const, chars: text.length }
    },
    now: () => new Date().toISOString(),
    challengeWorkspaceRoot: (eventId, challengeId) =>
      join(dir, "events", eventId, "challenges", challengeId, "workspace"),
    // The service wires the decision-point engine behind this seam; tests
    // record the posts it would be fed.
    onSchedulerInbox: (post) => inbox.push(post),
    ...(deps.clock ? { clock: deps.clock } : {}),
  })
  return { channels, sent, inbox, bus }
}

function seedAgent(
  db: Db,
  id: string,
  overrides: Partial<typeof agents.$inferInsert> = {}
) {
  db.insert(agents)
    .values({
      id,
      eventId: overrides.eventId ?? "evt-1",
      challengeId:
        overrides.challengeId === undefined ? "ch-1" : overrides.challengeId,
      role: overrides.role ?? "solver",
      name: overrides.name ?? `agent-${id.slice(0, 8)}`,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status: overrides.status ?? "idle",
      source: "manual",
      timeoutMs: 3_600_000,
      createdAt: now(),
      startedAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run()
  return id
}

/** The event's scheduler: one orchestrator agent row (challengeId null). */
function seedScheduler(db: Db, id: string, eventId = "evt-1") {
  return seedAgent(db, id, {
    eventId,
    challengeId: null,
    role: "orchestrator",
    name: "Scheduler",
  })
}

/** A workspace file inside the agent's OWN directory (attachment source). */
function putAgentFile(
  db: Db,
  dir: Dir,
  agentId: string,
  path: string,
  size: number
) {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get()!
  const abs = join(
    dir,
    "events",
    row.eventId,
    "challenges",
    row.challengeId!,
    "workspace",
    "agents",
    agentId.slice(0, 8),
    path
  )
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, "x".repeat(size))
  return abs
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** The legacy (pre-template) renderer — kept byte-identical on purpose. */
function timeOfLegacy(iso: string) {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`
}

function legacy(
  groups: Parameters<typeof renderMerged>[0],
  maxChars = 8_000,
  nowMs = Date.now()
): string {
  const header = `[当前时间] ${fmtClock(nowMs)}\n[频道消息]`
  const prefixLen = header.length + 1
  const blocks: string[][] = []
  for (const grp of groups) {
    for (const message of grp.messages) {
      const mark = message.urgent ? "⚠ " : ""
      const lines = [
        `${mark}${grp.label} · ${message.authorName} · ${timeOfLegacy(message.createdAt)}`,
        message.body.trim() || "(空)",
      ]
      for (const file of message.files) {
        lines.push(
          `📎 ${file.filename} · ${formatSize(file.size)} · ${file.path}`
        )
      }
      blocks.push(lines)
    }
  }
  const render = (kept: string[][]) =>
    [header, ...kept.flatMap((lines) => lines)].join("\n")
  if (render(blocks).length <= maxChars) return render(blocks)
  const budget = maxChars - prefixLen - 120
  let used = 0
  let kept = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const size = blocks[i].join("\n").length + 1
    if (used + size > budget) break
    used += size
    kept += 1
  }
  if (kept === 0 && blocks.length > 0) kept = 1
  const dropped = blocks.length - kept
  return dropped > 0
    ? [
        header,
        `另有 ${dropped} 条较新消息未并入本次投递（下次投递继续，或 aegisx.channels.read 补读）`,
        ...blocks.slice(0, kept).flatMap((lines) => lines),
      ].join("\n")
    : render(blocks)
}

function testGroup(n: number, pad = 0) {
  return {
    label: "#team",
    messages: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      authorName: `agent-${i}`,
      createdAt: new Date(2025, 0, 1, 12, i % 60).toISOString(),
      body: i % 3 === 0 ? "" : `body-${i} ${"x".repeat(pad)}`,
      urgent: i % 2 === 0,
      files:
        i % 4 === 0
          ? [
              {
                filename: `f${i}.py`,
                size: 4300 * (i + 1),
                path: `shared/from-a${i}/f${i}.py`,
              },
            ]
          : [],
    })),
  }
}

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
  test("challenge tree: #team + one DM per agent of the challenge, in creation order", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { name: "agent-a1" })
      seedAgent(db, "a2", { name: "agent-a2" })
      const { channels } = makeService(db, dir)
      // No ensure*, no rows — the tree derives from agent rows alone.
      const tree = channels.challengeChannelTree("ch-1")
      expect(tree.map((c) => c.key)).toEqual([
        teamKey("ch-1"),
        dmKey("a1"),
        dmKey("a2"),
      ])
      expect(tree.map((c) => c.kind)).toEqual(["team", "dm", "dm"])
      expect(tree[0].label).toBe("#team")
      expect(tree[1].agentId).toBe("a1")
      expect(tree[1].label).toBe("DM agent-a1")
      // UI trees pass a null reader → no per-reader unread.
      expect(tree.every((c) => c.unread === 0)).toBe(true)
      channels.close()
    } finally {
      close()
    }
  })

  test("challenge tree works with no agent on the challenge", () => {
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

  test("SDK list: solver = own team + own dm + orch; scheduler = every team + every solver dm + orch", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedChallenge(db, { id: "ch-2" })
      seedAgent(db, "a1", { challengeId: "ch-1" })
      seedAgent(db, "b1", { challengeId: "ch-2" })
      seedScheduler(db, "s1")
      const { channels } = makeService(db, dir)

      expect(
        channels.agentChannels("a1", agentPrincipal("a1")).map((c) => c.key)
      ).toEqual([teamKey("ch-1"), dmKey("a1"), orchKey("evt-1")])
      // The scheduler sees the whole event: both challenges' teams, every
      // solver's dm (creation order), and orch.
      expect(
        channels.agentChannels("s1", agentPrincipal("s1")).map((c) => c.key)
      ).toEqual([
        teamKey("ch-1"),
        teamKey("ch-2"),
        dmKey("a1"),
        dmKey("b1"),
        orchKey("evt-1"),
      ])
      channels.close()
    } finally {
      close()
    }
  })
})

describe("live fan-out (§二)", () => {
  function setup() {
    const lite = setupDbLite()
    seedEvent(lite.db)
    seedChallenge(lite.db, { id: "ch-1" })
    seedAgent(lite.db, "a1", { challengeId: "ch-1" })
    const bus = createLiveBus()
    return { ...lite, bus, made: makeService(lite.db, lite.dir, { bus }) }
  }

  test("every message emits ONE frame: #team keyed by challenge, dm by agent, orch by event", () => {
    const { close, bus, made } = setup()
    try {
      const frames: { channel: string; body: string; channelKey: string }[] = []
      const realEmit = bus.emit
      bus.emit = (channel, event) => {
        if (event.type === "channel.message") {
          frames.push({
            channel,
            body: event.message.body,
            channelKey: event.message.channelKey,
          })
        }
        realEmit(channel, event)
      }
      const post = (channelKey: string, body: string) =>
        made.channels.post({ channelKey, author: { type: "user" }, body }, USER)
      post(teamKey("ch-1"), "team-1")
      post(teamKey("ch-1"), "team-2")
      post(dmKey("a1"), "dm-1")
      post(orchKey("evt-1"), "orch-1")

      // Two team messages → two frames (not the old event + challenge pair).
      expect(frames).toEqual([
        { channel: "ch-1", body: "team-1", channelKey: teamKey("ch-1") },
        { channel: "ch-1", body: "team-2", channelKey: teamKey("ch-1") },
        { channel: "a1", body: "dm-1", channelKey: dmKey("a1") },
        { channel: "evt-1", body: "orch-1", channelKey: orchKey("evt-1") },
      ])
      made.channels.close()
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
    seedAgent(lite.db, "a1", { challengeId: "ch-1" })
    seedAgent(lite.db, "x1", { challengeId: "ch-2" })
    seedScheduler(lite.db, "s1")
    return { ...lite, made: makeService(lite.db, lite.dir) }
  }

  test("team:<cid>: same-challenge agents, the event scheduler, user, system; foreign agents rejected", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      const post = (author: Parameters<typeof channels.post>[0]["author"]) =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author,
            body: "b",
          },
          author.type === "user"
            ? USER
            : author.type === "system"
              ? SYSTEM
              : agentPrincipal(author.agentId)
        )
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
        channels.post(
          { channelKey: dmKey("a1"), author, body: "b" },
          author.type === "user"
            ? USER
            : author.type === "system"
              ? SYSTEM
              : agentPrincipal(author.agentId)
        )
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
        channels.post(
          { channelKey: orchKey("evt-1"), author, body: "b" },
          author.type === "user"
            ? USER
            : author.type === "system"
              ? SYSTEM
              : agentPrincipal(author.agentId)
        )
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

  test("agent posts accept the bare selectors with the same visibility as read (§9.1 write parity)", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      // "#team" / "team" resolve to the solver's own challenge team.
      const viaHash = channels.post(
        {
          channelKey: "#team",
          author: { type: "agent", agentId: "a1" },
          body: "angle: heap spray",
        },
        agentPrincipal("a1")
      )
      expect(viaHash.channelKey).toBe(teamKey("ch-1"))
      const viaBare = channels.post(
        {
          channelKey: "team",
          author: { type: "agent", agentId: "a1" },
          body: "same",
        },
        agentPrincipal("a1")
      )
      expect(viaBare.channelKey).toBe(teamKey("ch-1"))
      // "orch" resolves to the agent's event (the ask path).
      const viaOrch = channels.post(
        {
          channelKey: "orch",
          author: { type: "agent", agentId: "a1" },
          body: "need more time",
        },
        agentPrincipal("a1")
      )
      expect(viaOrch.channelKey).toBe(orchKey("evt-1"))
      // The write rules still apply on the resolved key: a foreign solver's
      // "#team" resolves to ITS OWN challenge — it can never address ch-1.
      const foreign = channels.post(
        {
          channelKey: "#team",
          author: { type: "agent", agentId: "x1" },
          body: "foreign",
        },
        agentPrincipal("x1")
      )
      expect(foreign.channelKey).toBe(teamKey("ch-2"))
      // user/system authors must address a full key.
      expect(() =>
        channels.post(
          {
            channelKey: "#team",
            author: { type: "user" },
            body: "x",
          },
          USER
        )
      ).toThrow(/非法频道键/)
      channels.close()
    } finally {
      close()
    }
  })

  test("agent posts carry the agent-name snapshot + stamped agentId meta", () => {
    const { close, made } = setup()
    try {
      const { channels } = made
      const message = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "finding",
        },
        agentPrincipal("a1")
      )
      expect(message.authorName).toBe("agent-a1")
      expect(message.meta.agentId).toBe("a1")
      const sys = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "system" },
          body: "sys",
        },
        SYSTEM
      )
      expect(sys.authorName).toBe("系统")
      expect(sys.meta.agentId).toBeUndefined()
      channels.close()
    } finally {
      close()
    }
  })
})

describe("urgent delivery matrix (§3.2 / §3.3)", () => {
  test("team urgent: one steer per live agent on the challenge; terminal agents store only", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running", name: "S1" })
      seedAgent(db, "a2", { status: "running", name: "S2" })
      seedAgent(db, "b1", { status: "idle", name: "S3" })
      seedAgent(db, "c1", { status: "completed" })
      const { channels, sent } = makeService(db, dir)

      // a1 posts urgent — a1's own post is never a1's unread; recipients:
      // a2 + b1 (the other live agents). c1 is terminal → store only.
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "cross-attempt finding",
          urgent: true,
        },
        agentPrincipal("a1")
      )
      await settle()
      expect(sent.map((s) => s.agentId).toSorted()).toEqual(["a2", "b1"])
      for (const s of sent) {
        expect(s.text).toContain("cross-attempt finding")
        // Unambiguous attribution: the agent's name in the author line.
        expect(s.text).toContain("S1")
      }
      // The terminal agent sees the message as UNREAD (store-only).
      expect(
        channels
          .agentChannels("c1", agentPrincipal("c1"))
          .find((c) => c.kind === "team")!.unread
      ).toBe(1)
      channels.close()
    } finally {
      close()
    }
  })

  test("dm urgent: cold-wakes a terminal agent and delivers ONLY the dm (red line)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a2", { status: "completed" })
      const { channels, sent } = makeService(db, dir)

      // Stored team backlog for the terminal agent — never swept on cold wake.
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "stored only",
        },
        USER
      )
      expect(sent).toHaveLength(0)

      channels.post(
        {
          channelKey: dmKey("a2"),
          author: { type: "user" },
          body: "wake up",
          urgent: true,
        },
        USER
      )
      await settle()
      expect(sent).toHaveLength(1)
      expect(sent[0].agentId).toBe("a2")
      expect(sent[0].text).toContain("wake up")
      // The stored #team backlog stays unread — the cold wake touches only
      // the target agent, and only its dm face.
      expect(sent[0].text).not.toContain("stored only")
      expect(
        channels
          .agentChannels("a2", agentPrincipal("a2"))
          .find((c) => c.kind === "team")!.unread
      ).toBe(1)
      channels.close()
    } finally {
      close()
    }
  })

  test("orch posts are a ledger: NO scheduler delivery; solver asks + user posts feed the engine's inbox hook", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running" })
      seedScheduler(db, "s1")
      const { channels, sent, inbox } = makeService(db, dir)

      // Solver urgent ask: stored in the ledger; the engine hook fires; NO
      // delivery (the decision-point engine is the only wake path now).
      channels.post(
        {
          channelKey: orchKey("evt-1"),
          author: { type: "agent", agentId: "a1" },
          body: "ask: which challenge next?",
          urgent: true,
        },
        agentPrincipal("a1")
      )
      await settle()
      expect(sent).toHaveLength(0)
      expect(inbox).toEqual([
        {
          eventId: "evt-1",
          kind: "orch",
          authorType: "agent",
          authorAgentId: "a1",
          body: "ask: which challenge next?",
        },
      ])
      expect(channels.unreadCount(orchKey("evt-1"), SCHEDULER_READ_KEY)).toBe(1)

      // User orch post: user.directive for the engine.
      inbox.length = 0
      channels.post(
        {
          channelKey: orchKey("evt-1"),
          author: { type: "user" },
          body: "focus web this hour",
          urgent: true,
        },
        USER
      )
      await settle()
      expect(sent).toHaveLength(0)
      expect(inbox).toEqual([
        {
          eventId: "evt-1",
          kind: "orch",
          authorType: "user",
          body: "focus web this hour",
        },
      ])

      // System posts carry their own triggers — no inbox hook call.
      inbox.length = 0
      channels.post(
        {
          channelKey: orchKey("evt-1"),
          author: { type: "system" },
          body: "system ledger line",
        },
        SYSTEM
      )
      await settle()
      expect(inbox).toHaveLength(0)
      channels.close()
    } finally {
      close()
    }
  })

  test("a user DM to the scheduler agent feeds the engine hook; no delivery face for the scheduler", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedScheduler(db, "s1")
      const { channels, sent, inbox } = makeService(db, dir)

      channels.post(
        {
          channelKey: dmKey("s1"),
          author: { type: "user" },
          body: "hold the pwn series",
          urgent: true,
        },
        USER
      )
      await settle()
      expect(sent).toHaveLength(0)
      expect(inbox).toEqual([
        {
          eventId: "evt-1",
          kind: "dm",
          authorType: "user",
          body: "hold the pwn series",
        },
      ])
      channels.close()
    } finally {
      close()
    }
  })

  test("non-urgent posts never deliver immediately — they ride the flush tick (urgent-team policy off)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running" })
      seedAgent(db, "a2", { status: "running" })
      disableUrgentTeam(db)
      const { channels, sent } = makeService(db, dir)

      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "fyi finding",
        },
        agentPrincipal("a1")
      )
      await settle()
      expect(sent).toHaveLength(0) // policy off = wait for the tick
      channels.close()
    } finally {
      close()
    }
  })

  test("urgent-team policy ON upgrades a non-urgent #team post to immediate delivery (the default)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running" })
      seedAgent(db, "a2", { status: "running" })
      // No scheduler_config row → policy defaults ON.
      const { channels, sent } = makeService(db, dir)

      const posted = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "fyi finding",
        },
        agentPrincipal("a1")
      )
      await settle()
      // Immediate delivery to the sibling (own post excluded) + urgent meta.
      expect(sent.map((s) => s.agentId)).toEqual(["a2"])
      expect(posted.meta.urgent).toBe(true)
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
      seedAgent(db, "a1", { status: "running" })
      seedAgent(db, "a2", { status: "running" })
      const { channels, sent } = makeService(db, dir)
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "system" },
          body: "deadline tight",
          urgent: true,
        },
        SYSTEM
      )
      await settle()
      expect(sent[0].text).toContain("[频道消息]")
      expect(sent[0].text).toContain("⚠ ")
      channels.close()
    } finally {
      close()
    }
  })
})

describe("flush tick (solver-facing; the scheduler has no delivery face)", () => {
  test("the tick delivers every live reader's backlog as one merged steer each", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running" })
      seedAgent(db, "a2", { status: "running" })
      seedAgent(db, "b1", { status: "idle" })
      seedAgent(db, "c1", { status: "completed" })
      seedScheduler(db, "s1")
      disableUrgentTeam(db)
      const { channels, sent } = makeService(db, dir)

      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "c1" },
          body: "m1",
        },
        agentPrincipal("c1")
      )
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "m2",
        },
        USER
      )
      channels.post(
        {
          channelKey: orchKey("evt-1"),
          author: { type: "system" },
          body: "agent started",
        },
        SYSTEM
      )
      channels.runFlushTick()
      await settle()

      // a1 gets the agent post m1 (not its own), a2 + b1 get both — each as
      // ONE steer. c1 (terminal): store only. s1 (scheduler) gets NOTHING:
      // the flush tick services live solvers only; the orch ledger stays
      // unread for its SDK reads and the engine drives its turns.
      const byAgent = new Map<string, string[]>()
      for (const s of sent) {
        byAgent.set(s.agentId, [...(byAgent.get(s.agentId) ?? []), s.text])
      }
      expect([...byAgent.keys()].toSorted()).toEqual(["a1", "a2", "b1"])
      for (const agentId of ["a1", "a2", "b1"]) {
        expect(byAgent.get(agentId)).toHaveLength(1)
      }
      expect(byAgent.get("a2")![0]).toContain("m1")
      expect(byAgent.get("a2")![0]).toContain("m2")
      expect(channels.unreadCount(orchKey("evt-1"), SCHEDULER_READ_KEY)).toBe(1)
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

  test("inboxSnapshot: orch key + stable-cursor unread (the scheduler reads via the SDK)", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedScheduler(db, "s1")
      const { channels } = makeService(db, dir)
      const snap = channels.inboxSnapshot("evt-1")
      expect(snap.channelKey).toBe(orchKey("evt-1"))
      expect(snap.unreadCount).toBe(0)
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
      seedAgent(db, "a1", { status: "running" })
      seedAgent(db, "a2", { status: "running" })
      disableUrgentTeam(db)
      const { channels, sent } = makeService(db, dir)

      // 1. Self-post: author cursor lands on the message id.
      const own = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "self",
        },
        agentPrincipal("a1")
      )
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(own.id)

      // 2. SDK read (pull = consume): a user post lands, a1 reads it.
      const hello = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "hello",
        },
        USER
      )
      const read = channels.readForAgent(agentPrincipal("a1"), "#team")
      expect(read.items.map((m) => m.body)).toContain("hello")
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(
        read.items.at(-1)!.id
      )
      expect(read.channel.key).toBe(teamKey("ch-1"))

      // 3. Deliver after the pull: nothing new → no steer.
      sent.length = 0
      await channels.deliverAgentAwaited("a1")
      expect(sent).toHaveLength(0)

      // a2 has authored nothing: BOTH messages are unread (own-post filter
      // only applies to the author).
      expect(channels.unreadCount(teamKey("ch-1"), "a2")).toBe(2)
      await channels.deliverAgentAwaited("a2")
      expect(sent.map((s) => s.agentId)).toEqual(["a2"])
      expect(channels.readCursor(teamKey("ch-1"), "a2")).toBe(hello.id)
      channels.close()
    } finally {
      close()
    }
  })

  test("onboarding deliver: a fresh agent (cursor 0) sweeps the whole #team history once (§11.3)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "completed" })
      const { channels, sent } = makeService(db, dir)
      // Prior knowledge sitting in #team (terminal agent → stored, not delivered).
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "prior finding: heap overflow in edit()",
        },
        agentPrincipal("a1")
      )
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "system" },
          body: "remote libc 2.35 — trust the target",
        },
        SYSTEM
      )

      // A fresh agent on the same challenge: cursor 0 → one deliver sweeps BOTH.
      seedAgent(db, "b1", { status: "running" })
      await channels.deliverAgentAwaited("b1")
      expect(sent.map((s) => s.agentId)).toEqual(["b1"])
      expect(sent[0].text).toContain("prior finding: heap overflow in edit()")
      expect(sent[0].text).toContain("remote libc 2.35 — trust the target")
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
      seedAgent(db, "a1", { challengeId: "ch-1", status: "running" })
      seedAgent(db, "x1", { challengeId: "ch-2", status: "running" })
      seedScheduler(db, "s1")
      const { channels } = makeService(db, dir)

      expect(
        channels.readForAgent(agentPrincipal("a1"), "#team").channel.key
      ).toBe(teamKey("ch-1"))
      expect(
        channels.readForAgent(agentPrincipal("a1"), "team").channel.key
      ).toBe(teamKey("ch-1"))
      expect(
        channels.readForAgent(agentPrincipal("a1"), "orch").channel.key
      ).toBe(orchKey("evt-1"))
      expect(
        channels.readForAgent(agentPrincipal("a1"), dmKey("a1")).channel.key
      ).toBe(dmKey("a1"))
      // Visibility: a solver cannot read a foreign team, another agent's dm.
      expect(() =>
        channels.readForAgent(agentPrincipal("a1"), teamKey("ch-2"))
      ).toThrow(/无权/)
      expect(() =>
        channels.readForAgent(agentPrincipal("a1"), dmKey("x1"))
      ).toThrow(/无权/)
      // The scheduler addresses teams by key ("#team" is a solver shortcut).
      expect(
        channels.readForAgent(agentPrincipal("s1"), teamKey("ch-1")).channel.key
      ).toBe(teamKey("ch-1"))
      expect(
        channels.readForAgent(agentPrincipal("s1"), dmKey("a1")).channel.key
      ).toBe(dmKey("a1"))
      expect(() =>
        channels.readForAgent(agentPrincipal("s1"), "#team")
      ).toThrow(/调度者/)
      // markRead=false leaves the cursor alone (pull without consuming).
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "unread probe",
        },
        USER
      )
      const before = channels.readCursor(teamKey("ch-1"), "a1")
      channels.readForAgent(agentPrincipal("a1"), "#team", { markRead: false })
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(before)
      channels.close()
    } finally {
      close()
    }
  })
})

describe("SDK pull paging (forward window)", () => {
  test("default pull returns the OLDEST unconsumed window; the cursor lands on its last id only", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1")
      disableUrgentTeam(db)
      const { channels } = makeService(db, dir)
      for (let i = 1; i <= 55; i += 1) {
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "system" },
            body: `m${i}`,
          },
          SYSTEM
        )
      }

      const page = channels.readForAgent(agentPrincipal("a1"), "#team")
      expect(page.items).toHaveLength(50)
      expect(page.items[0].body).toBe("m1")
      expect(page.items[49].body).toBe("m50")
      expect(page.hasMore).toBe(true)
      expect(page.nextAfter).toBe(page.items[49].id)
      // The cursor advanced onto exactly the consumed frontier — nothing
      // above it was skipped (the old newest-window jump lost the head).
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(page.nextAfter)
      expect(channels.unreadCount(teamKey("ch-1"), "a1")).toBe(5)
      channels.close()
    } finally {
      close()
    }
  })

  test("paging forward drains the backlog with no gaps; the final cursor equals the newest id", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1")
      disableUrgentTeam(db)
      const { channels } = makeService(db, dir)
      for (let i = 1; i <= 55; i += 1) {
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "system" },
            body: `m${i}`,
          },
          SYSTEM
        )
      }

      const seen: number[] = []
      let after = 0
      let pages = 0
      for (;;) {
        const page = channels.readForAgent(agentPrincipal("a1"), "#team", {
          after,
        })
        seen.push(...page.items.map((m) => m.id))
        pages += 1
        after = page.nextAfter
        if (!page.hasMore) break
      }
      expect(pages).toBe(2)
      // No gaps, no repeats: the pulls reconstructed the channel's rows
      // in order.
      const channelIds = db
        .select({ id: channelMessages.id })
        .from(channelMessages)
        .where(eq(channelMessages.channelKey, teamKey("ch-1")))
        .all()
        .map((r) => r.id)
      expect(seen).toEqual(channelIds)
      // The drained cursor sits on the newest message.
      expect(channels.readCursor(teamKey("ch-1"), "a1")).toBe(
        channelIds[channelIds.length - 1]
      )
      // A re-pull past the frontier returns nothing new.
      const tail = channels.readForAgent(agentPrincipal("a1"), "#team", {
        after,
      })
      expect(tail.items).toHaveLength(0)
      expect(tail.hasMore).toBe(false)
      expect(tail.nextAfter).toBe(after)
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
            id: 1,
            authorName: "agent-a1",
            createdAt: "2025-01-01T00:00:00Z",
            body: "exp 骨架在 exp2.py",
            urgent: true,
            files: [
              {
                filename: "exp2.py",
                size: 4300,
                path: "shared/from-a1/exp2.py",
              },
            ],
          },
        ],
      },
    ])
    expect(text).toContain("[频道消息]")
    expect(text).toContain("⚠ #team · agent-a1")
    expect(text).toContain("exp 骨架在 exp2.py")
    expect(text).toContain(
      `📎 exp2.py · ${formatSize(4300)} · shared/from-a1/exp2.py`
    )
    expect(text).not.toContain("xxxx")
  })

  test("overflow folds the NEWEST messages within the 8K cap (oldest = ground truth)", () => {
    const text = renderMerged([
      {
        label: "#team",
        messages: Array.from({ length: 30 }, (_, i) => ({
          id: i + 1,
          authorName: "system",
          createdAt: "2025-01-01T00:00:00Z",
          body: `msg-${i} ${"y".repeat(900)}`,
          urgent: false,
          files: [],
        })),
      },
    ])
    expect(text.length).toBeLessThanOrEqual(8_200)
    expect(text).toContain("条较新消息未并入本次投递")
    expect(text).toContain("msg-0") // oldest kept
    expect(text).not.toContain("msg-29 ") // newest folded
  })

  // The template-driven renderer must reproduce the legacy (pre-template)
  // format byte-for-byte with the default builtin body — the folding math
  // included. This locks the channelDelivery default against regressions.
  test("default template renders byte-identical to the legacy renderer", () => {
    // Pinned delivery clock: the default header now carries the wall clock,
    // so byte-identity needs the same instant on both sides.
    const nowMs = Date.parse("2026-09-10T14:32:00+08:00")
    const render = (groups: Parameters<typeof renderMerged>[0]) =>
      renderDelivery(DEFAULT_CHANNEL_DELIVERY_TEMPLATE, groups, 8_000, nowMs)
    const matrix = [
      { label: "#team", messages: [] },
      testGroup(1),
      testGroup(12),
      testGroup(12, 900), // exercises the overflow path
      testGroup(60, 400), // deep overflow
    ]
    for (const groups of matrix) {
      expect(render([groups]).text).toBe(legacy([groups], 8_000, nowMs))
    }
    // Multi-group interleaving (team + dm faces in one delivery).
    expect(
      render([
        testGroup(3),
        { label: "#orch", messages: testGroup(2).messages },
      ]).text
    ).toBe(
      legacy(
        [testGroup(3), { label: "#orch", messages: testGroup(2).messages }],
        8_000,
        nowMs
      )
    )
  })

  test("every delivery opens with the current wall clock", () => {
    const nowMs = Date.parse("2026-09-10T14:32:00+08:00")
    const text = renderDelivery(
      DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
      [testGroup(1)],
      8_000,
      nowMs
    ).text
    expect(text.split("\n")[0]).toBe(`[当前时间] ${fmtClock(nowMs)}`)
    expect(fmtClock(nowMs)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe("attachments — shared/ mechanism (§六)", () => {
  function setup() {
    const lite = setupDbLite()
    seedEvent(lite.db)
    seedChallenge(lite.db, { id: "ch-1" })
    seedAgent(lite.db, "a1", { status: "running" })
    return { ...lite, made: makeService(lite.db, lite.dir) }
  }

  test("agent attachment: copied into shared/from-<id8>/; meta carries the shared path", () => {
    const { db, dir, close, made } = setup()
    try {
      const { channels } = made
      putAgentFile(db, dir, "a1", "exp2.py", 4300)
      const message = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "exp 骨架在 exp2.py",
          files: ["exp2.py"],
        },
        agentPrincipal("a1")
      )
      expect(message.files).toHaveLength(1)
      expect(message.files[0].filename).toBe("exp2.py")
      expect(message.files[0].size).toBe(4300)
      // The reader-facing shared path (relative to the workspace root).
      expect(message.files[0].path).toBe("shared/from-a1/exp2.py")
      // The bytes are a copy inside the challenge workspace's shared/ tree.
      const host = join(
        dir,
        "events",
        "evt-1",
        "challenges",
        "ch-1",
        "workspace",
        "shared",
        "from-a1",
        "exp2.py"
      )
      expect(existsSync(host)).toBe(true)
      made.channels.close()
    } finally {
      close()
    }
  })

  test("duplicate names in shared/from-<id8>/ get -2 suffixes", () => {
    const { db, dir, close, made } = setup()
    try {
      const { channels } = made
      putAgentFile(db, dir, "a1", "poc.py", 10)
      const first = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "one",
          files: ["poc.py"],
        },
        agentPrincipal("a1")
      )
      const second = channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "two",
          files: ["poc.py"],
        },
        agentPrincipal("a1")
      )
      expect(first.files[0].path).toBe("shared/from-a1/poc.py")
      expect(second.files[0].path).toBe("shared/from-a1/poc-2.py")
      made.channels.close()
    } finally {
      close()
    }
  })

  test("path validation: escapes, absolute paths and missing files rejected", () => {
    const { db, dir, close, made } = setup()
    try {
      const { channels } = made
      putAgentFile(db, dir, "a1", "poc.py", 100)
      const post = (files: string[]) =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "agent", agentId: "a1" },
            body: "b",
            files,
          },
          agentPrincipal("a1")
        )
      expect(() => post(["../../etc/passwd"])).toThrow(/越界/)
      expect(() => post(["/etc/passwd"])).toThrow(/不合法/)
      expect(() => post(["missing.py"])).toThrow(/不存在/)
      expect(() => post(["poc.py"])).not.toThrow()
      made.channels.close()
    } finally {
      close()
    }
  })

  test("the scheduler cannot send workspace attachments (no agent dir)", () => {
    const { db, close, made } = setup()
    try {
      seedScheduler(db, "s1")
      const { channels } = made
      expect(() =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "agent", agentId: "s1" },
            body: "b",
            files: ["whatever.py"],
          },
          agentPrincipal("s1")
        )
      ).toThrow(/只有解题 agent/)
      made.channels.close()
    } finally {
      close()
    }
  })

  test("caps: 8 files per message, 16K body chars, 64MB per file, 128MB total", () => {
    const { db, dir, close, made } = setup()
    try {
      const { channels } = made
      for (let i = 0; i < 9; i += 1) putAgentFile(db, dir, "a1", `f${i}`, 1)
      expect(() =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "agent", agentId: "a1" },
            body: "b",
            files: Array.from({ length: 9 }, (_, i) => `f${i}`),
          },
          agentPrincipal("a1")
        )
      ).toThrow(/最多 8 个附件/)
      expect(() =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "agent", agentId: "a1" },
            body: "x".repeat(16_001),
          },
          agentPrincipal("a1")
        )
      ).toThrow(/16_?000|16,000|16K/)
      // Sparse 65MB file: statSync sees the size, no data written.
      const big = putAgentFile(db, dir, "a1", "big.bin", 1)
      truncateSync(big, 65 * 1024 * 1024)
      expect(() =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "agent", agentId: "a1" },
            body: "b",
            files: ["big.bin"],
          },
          agentPrincipal("a1")
        )
      ).toThrow(/64MB/)
      // Workspace attachments are agent-only.
      expect(() =>
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "user" },
            body: "b",
            files: ["poc.py"],
          },
          USER
        )
      ).toThrow(/只能由 agent/)
      made.channels.close()
    } finally {
      close()
    }
  })

  test("user multipart upload: urgent defaults TRUE; blobs land in shared/upload-<ts>/; stream failure rolls the whole message back", async () => {
    const { db, close, made } = setup()
    try {
      seedAgent(db, "a2", { status: "running" })
      const { channels, sent } = made
      const message = await channels.postWithUpload(
        {
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
        },
        USER
      )
      expect(message.files).toHaveLength(1)
      expect(message.files[0].filename).toBe("notes.txt")
      expect(message.files[0].size).toBe(5)
      expect(message.files[0].path).toMatch(/^shared\/upload-\d+\/notes\.txt$/)
      // urgent default true on the user path → both live agents got the
      // steer (the author is the user — no own-post exclusion).
      await settle()
      expect(sent.map((s) => s.agentId).toSorted()).toEqual(["a1", "a2"])
      expect(sent[0].text).toContain("📎 notes.txt")

      // Rollback: a failing second upload drops the message row (the first
      // upload's shared copy is orphaned under upload-<ts>/ — best effort,
      // swept with the workspace).
      const before = db.select().from(channelMessages).all().length
      await expect(
        channels.postWithUpload(
          {
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
          },
          USER
        )
      ).rejects.toThrow(/disk full/)
      expect(db.select().from(channelMessages).all().length).toBe(before)
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
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "system" },
            body: `m${i}`,
          },
          SYSTEM
        )
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
  test("agent deletion removes its dm data; #team knowledge survives", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running" })
      const { channels } = makeService(db, dir)
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "agent", agentId: "a1" },
          body: "knowledge",
        },
        agentPrincipal("a1")
      )
      channels.post(
        {
          channelKey: dmKey("a1"),
          author: { type: "user" },
          body: "dm note",
        },
        USER
      )
      channels.markRead(dmKey("a1"), "a1", 99)

      channels.cleanupAgentChannels("a1")
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
      // The #team knowledge base survives single-agent deletion.
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

  test("event deletion sweeps orch + every team + every dm", () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "running" })
      const { channels } = makeService(db, dir)
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "team",
        },
        USER
      )
      channels.post(
        {
          channelKey: orchKey("evt-1"),
          author: { type: "system" },
          body: "evt",
        },
        SYSTEM
      )
      channels.post(
        {
          channelKey: dmKey("a1"),
          author: { type: "user" },
          body: "dm",
        },
        USER
      )

      channels.cleanupEventChannels("evt-1")
      expect(db.select().from(channelMessages).all()).toHaveLength(0)
      expect(db.select().from(channelReads).all()).toHaveLength(0)
      channels.close()
    } finally {
      close()
    }
  })
})

describe("terminal agents and urgent delivery (kill-undo guard)", () => {
  test("an urgent #team broadcast never reaches a terminal agent; an urgent DM cold-wakes it", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "aborted" })
      seedAgent(db, "a2", { status: "running" })
      const { channels, sent } = makeService(db, dir)

      // Urgent broadcast: only the live reader receives it. The aborted
      // agent stays dead (a delivery must never reopen what a close killed).
      channels.post(
        {
          channelKey: teamKey("ch-1"),
          author: { type: "user" },
          body: "storm notice",
          urgent: true,
        },
        USER
      )
      expect(sent.map((s) => s.agentId)).toEqual(["a2"])

      // Targeted urgent DM: the ONE sanctioned wake path for a terminal
      // agent (the scheduler intervening on a wrongly-stopped agent).
      channels.post(
        {
          channelKey: dmKey("a1"),
          author: { type: "user" },
          body: "wake up",
          urgent: true,
        },
        USER
      )
      expect(sent.map((s) => s.agentId)).toEqual(["a2", "a1"])
      channels.close()
    } finally {
      close()
    }
  })

  test("a NON-urgent DM to a terminal agent stays stored (no cold wake)", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "a1", { status: "completed" })
      const { channels, sent } = makeService(db, dir)
      channels.post(
        {
          channelKey: dmKey("a1"),
          author: { type: "user" },
          body: "later",
        },
        USER
      )
      expect(sent).toHaveLength(0)
      channels.close()
    } finally {
      close()
    }
  })
})

const groundTruthBodyOf = (i: number) => `ground-truth-${i} ${"x".repeat(600)}`

describe("delivery budget folds the NEWEST, keeps the OLDEST (ground truth first)", () => {
  test("over-budget onboarding sweep delivers oldest-first, cursor advances only past the delivered, batches converge", async () => {
    const { db, dir, close } = setupDbLite()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      seedAgent(db, "fresh")
      disableUrgentTeam(db)
      const { channels, sent } = makeService(db, dir)

      for (let i = 1; i <= 30; i += 1) {
        channels.post(
          {
            channelKey: teamKey("ch-1"),
            author: { type: "user", name: "u" },
            body: groundTruthBodyOf(i),
          },
          USER
        )
      }

      channels.runFlushTick()
      await settle()
      expect(sent).toHaveLength(1)
      const first = sent[0].text
      // The earliest findings (entry points / credentials) must survive.
      expect(first).toContain("ground-truth-1 ")
      expect(first).not.toContain("ground-truth-30 ")
      // The fold line points at the not-yet-delivered NEWER messages.
      expect(first).toContain("较新消息")
      // Cursor advanced past exactly the delivered prefix, not everything.
      const cursor = channels.readCursor(teamKey("ch-1"), "fresh")
      expect(cursor).toBeGreaterThan(0)
      expect(cursor).toBeLessThan(30)

      // Successive ticks keep making progress until the whole backlog lands.
      for (let tick = 0; tick < 4; tick += 1) {
        channels.runFlushTick()
        await settle()
      }
      const all = sent.map((entry) => entry.text).join("\n")
      for (let i = 1; i <= 30; i += 1) {
        expect(all).toContain(`ground-truth-${i} `)
      }
      channels.close()
    } finally {
      close()
    }
  })
})
