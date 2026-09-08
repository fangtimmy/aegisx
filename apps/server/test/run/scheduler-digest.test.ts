import { describe, expect, test } from "bun:test"

import { createDatabase } from "../../src/db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  queueState,
  spawnQueue,
} from "../../src/db/schema"
import { DEFAULT_SCHEDULER_DIGEST_TEMPLATE } from "../../src/orchestration/prompt-defaults"
import { renderTemplateBody } from "../../src/orchestration/prompt-templates"
import { createAgentQueries } from "../../src/run/queries"
import { createSchedulerAdmin } from "../../src/run/scheduler-admin"
import { flatSettings, seedChallenge, seedEvent, now } from "../helpers"
import { refine } from "../support"

function setup() {
  const dir = `/tmp/aegisx-digest-${crypto.randomUUID()}`
  const { db, releaseLock } = createDatabase(dir)
  const admin = createSchedulerAdmin({
    db,
    queries: createAgentQueries({ db }),
    getSettings: flatSettings,
    now,
    providers: () => [],
    modelResolver: refine({}),
  })
  return { db, admin, close: () => releaseLock() }
}

function seedLiveAgent(
  db: ReturnType<typeof createDatabase>["db"],
  id: string,
  challengeId: string,
  status: "running" | "idle"
) {
  db.insert(agents)
    .values({
      id,
      eventId: "evt-1",
      challengeId,
      role: "solver",
      name: `agent-${id}`,
      model: "m",
      systemPrompt: "s",
      tools: "[]",
      status,
      source: "manual",
      timeoutMs: 3_600_000,
      createdAt: now(),
      startedAt: now(),
      updatedAt: now(),
    })
    .run()
}

function seedQueueItem(
  db: ReturnType<typeof createDatabase>["db"],
  id: string,
  challengeId: string,
  status: "pending" | "running" | "done" | "cancelled" | "failed"
) {
  db.insert(spawnQueue)
    .values({
      id,
      eventId: "evt-1",
      ord: 1,
      challengeId,
      params: "{}",
      prompt: "p",
      source: "scheduler",
      status,
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
}

describe("scheduler digest (getDigestContext + default template)", () => {
  test("caps, queue state, per-challenge lines; quiet challenges omitted", () => {
    const { db, admin, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "web1", points: 300 })
      seedChallenge(db, {
        id: "ch-2",
        name: "pwn2",
        points: 500,
        manualSolveState: "partial",
      })
      seedChallenge(db, { id: "ch-3", name: "quiet" }) // no agents, no queue

      seedLiveAgent(db, "a1", "ch-1", "running")
      seedLiveAgent(db, "a2", "ch-1", "idle")
      seedLiveAgent(db, "a3", "ch-2", "idle")
      seedQueueItem(db, "q1", "ch-1", "pending")
      seedQueueItem(db, "q2", "ch-2", "running")

      // ch-1: remote-solved flag marks it solved.
      db.insert(challengeRemote)
        .values({
          challengeId: "ch-1",
          eventId: "evt-1",
          sourceKey: "k",
          remoteId: "r1",
          available: true,
          solved: true,
          syncedAt: now(),
        })
        .run()
      // ch-2 has a manual "partial" override (takes precedence).
      // An accepted flag on a third busy challenge would also mark solved.
      db.insert(queueState)
        .values({ eventId: "evt-1", status: "paused", updatedAt: now() })
        .run()

      const ctx = admin.getDigestContext("evt-1")
      expect(ctx.agents).toEqual({ live: 3, max: 4 })
      expect(ctx.queue).toEqual({ pending: 1, running: 1, paused: true })
      const names = ctx.challenges.map((c) => c.name)
      expect(names).toEqual(["web1", "pwn2"]) // quiet dropped
      expect(ctx.challenges[0]).toEqual({
        name: "web1",
        points: 300,
        solvedLabel: "已解",
        live: 2,
        running: 1,
        pending: 1,
        attempts: 2,
        tokens: "",
      })
      expect(ctx.challenges[1].solvedLabel).toBe("部分")

      const text = renderTemplateBody(DEFAULT_SCHEDULER_DIGEST_TEMPLATE, ctx)
      expect(text).toContain("Agent 槽位：3/4")
      expect(text).toContain("队列：1 待发 / 1 运行（已暂停）")
      expect(text).toContain(
        "- web1 · 300pt · 已解 · 2 live（1 running） · 队列 1 · 已投 2 次"
      )
      expect(text).toContain("- pwn2 · 500pt · 部分 · 1 live（0 running）")
      expect(text).not.toContain("quiet")
      expect(text).toContain("aegisx.snapshot()")
    } finally {
      close()
    }
  })

  test("accepted flag marks a challenge solved; empty event renders the header only", () => {
    const { db, admin, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "crypto1", points: 100 })
      seedLiveAgent(db, "a1", "ch-1", "running")
      db.insert(challengeFlags)
        .values({
          id: "f1",
          challengeId: "ch-1",
          flag: "flag{x}",
          status: "accepted",
          source: "agent",
          agentId: "a1",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const ctx = admin.getDigestContext("evt-1")
      expect(ctx.challenges[0].solvedLabel).toBe("已解")
      expect(ctx.agents.live).toBe(1)

      const text = renderTemplateBody(DEFAULT_SCHEDULER_DIGEST_TEMPLATE, ctx)
      expect(text).toContain("crypto1 · 100pt · 已解")
    } finally {
      close()
    }
  })
})

describe("scheduler digest: invested attempts + cumulative tokens", () => {
  test("attempts collapse queue-item replays; tokens aggregate the challenge's agents", () => {
    const { db, admin, close } = setup()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1", name: "web1", points: 300 })
      seedChallenge(db, { id: "ch-2", name: "pwn2", points: 500 })
      seedLiveAgent(db, "a1", "ch-1", "running")
      seedLiveAgent(db, "a2", "ch-1", "idle")
      seedLiveAgent(db, "b1", "ch-2", "running")
      // Three ghost-replay rows sharing one queue item → ONE attempt.
      for (const [id, created] of [
        ["g1", "2025-01-01T00:00:01.000Z"],
        ["g2", "2025-01-01T00:00:02.000Z"],
        ["g3", "2025-01-01T00:00:03.000Z"],
      ] as const) {
        db.insert(agents)
          .values({
            id,
            eventId: "evt-1",
            challengeId: "ch-1",
            role: "solver",
            name: `agent-${id}`,
            model: "m",
            systemPrompt: "s",
            tools: "[]",
            status: "aborted",
            source: "scheduler",
            timeoutMs: 3_600_000,
            queueItemId: "qg",
            createdAt: created,
            startedAt: created,
            updatedAt: created,
          })
          .run()
      }
      // One assistant entry on a1: 1.5M prompt tokens.
      db.insert(require("../../src/db/schema").sessions)
        .values({ id: "s-a1", agentId: "a1", cwd: "/w", createdAt: now() })
        .run()
      db.insert(require("../../src/db/schema").sessionEntries)
        .values({
          id: "e-1",
          sessionId: "s-a1",
          agentId: "a1",
          seq: 1,
          type: "message",
          data: JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              usage: { input: 1_500_000, output: 0 },
            },
          }),
          createdAt: now(),
        })
        .run()

      const ctx = admin.getDigestContext("evt-1")
      const web1 = ctx.challenges.find((c) => c.name === "web1")!
      const pwn2 = ctx.challenges.find((c) => c.name === "pwn2")!
      // 2 direct live + 1 collapsed replay group.
      expect(web1.attempts).toBe(3)
      expect(web1.tokens).toBe("1.5M")
      expect(pwn2.attempts).toBe(1)
      expect(pwn2.tokens).toBe("")

      const text = renderTemplateBody(DEFAULT_SCHEDULER_DIGEST_TEMPLATE, ctx)
      expect(text).toContain("已投 3 次 · 1.5M tok")
      // No dangling separator when nothing was spent.
      expect(text).not.toContain("已投 1 次 ·")
    } finally {
      close()
    }
  })
})
