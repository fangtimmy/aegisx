import { describe, expect, test } from "bun:test"

import type { MessageList } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import type { createDatabase } from "../../src/db"
import { orchestrators } from "../../src/db/schema"
import { buildOrchestratorToolContext } from "../../src/orchestrator/service"
import type { RunService } from "../../src/run/service"
import {
  flatSettings,
  makeProvider,
  seedChallenge,
  seedEvent,
  seedOrchestrator,
  seedRun,
  setupDb,
  toConnection,
} from "../helpers"

/** Minimal runService stub: only the methods buildToolContext calls. */
function stubRunService(
  listMessages = (): MessageList => ({ items: [], nextAfter: 0 })
) {
  return {
    create: async () => ({ id: "new-run", status: "running" }),
    stop: async (id: string) => ({ id, status: "idle" }),
    sendMessage: async (id: string) => ({ id, status: "running" }),
    closeRun: async (id: string) => ({ id, status: "closed" }),
    listMessages,
  } as unknown as RunService
}

const stubResolveModelSelection = () => {
  const provider = toConnection(makeProvider())
  return { provider, model: provider.models[0] }
}

const stubContainerConfig = () => ({
  image: "img",
  cpus: 1,
  memoryMb: 512,
  pidsLimit: 64,
  tmpfsSize: "64m",
  workspace: "/workspace",
})

describe("buildOrchestratorToolContext", () => {
  test("listChallenges aggregates per-challenge run activity for the event", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1", name: "Alpha" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1", name: "Beta" })
      seedEvent(db, "evt-2")
      seedChallenge(db, { id: "ch-x", eventId: "evt-2", name: "Other" })
      seedRun(db, {
        id: "r1",
        challengeId: "ch-a",
        status: "running",
        createdAt: "2025-01-02T00:00:00Z",
      })
      seedRun(db, {
        id: "r2",
        challengeId: "ch-a",
        status: "closed",
        createdAt: "2025-01-01T00:00:00Z",
      })

      const ctx = buildOrchestratorToolContext({
        db,
        eventId: "evt-1",
        getRow: () => ({ maxConcurrentTargets: 2 }) as never,
        getSettings: flatSettings,
        runService: stubRunService(),
        resolveModelSelection: stubResolveModelSelection,
        containerConfig: stubContainerConfig,
      })

      const list = ctx.listChallenges().sort((a, b) => a.id.localeCompare(b.id))
      expect(list.map((c) => c.id)).toEqual(["ch-a", "ch-b"])
      const alpha = list.find((c) => c.id === "ch-a")
      expect(alpha?.attempts).toBe(2)
      expect(alpha?.hasRunningRun).toBe(true)
      expect(alpha?.lastRunStatus).toBe("running")
      const beta = list.find((c) => c.id === "ch-b")
      expect(beta?.attempts).toBe(0)
      expect(beta?.hasRunningRun).toBe(false)
      expect(beta?.lastRunStatus).toBeNull()
    } finally {
      close()
    }
  })

  test("readRun rejects a run that belongs to another event", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedEvent(db, "evt-2")
      seedChallenge(db, { id: "ch-x", eventId: "evt-2" })
      seedRun(db, { id: "r-foreign", challengeId: "ch-x", status: "running" })

      const ctx = buildOrchestratorToolContext({
        db,
        eventId: "evt-1",
        getRow: () => ({ maxConcurrentTargets: 1 }) as never,
        getSettings: flatSettings,
        runService: stubRunService(),
        resolveModelSelection: stubResolveModelSelection,
        containerConfig: stubContainerConfig,
      })

      const res = await ctx.readRun("r-foreign", {})
      expect(res.items).toEqual([])
      expect(res.reason).toBe("Run belongs to another event")
    } finally {
      close()
    }
  })

  test("readRun reports a missing run", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const ctx = buildOrchestratorToolContext({
        db,
        eventId: "evt-1",
        getRow: () => ({ maxConcurrentTargets: 1 }) as never,
        getSettings: flatSettings,
        runService: stubRunService(),
        resolveModelSelection: stubResolveModelSelection,
        containerConfig: stubContainerConfig,
      })
      const res = await ctx.readRun("nope", {})
      expect(res.reason).toBe("Run not found")
    } finally {
      close()
    }
  })

  test("getStatus surfaces only active runs of the event", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedOrchestrator(db, "evt-1", { maxConcurrentTargets: 3 })
      seedChallenge(db, { id: "ch-a", eventId: "evt-1", name: "Alpha" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1", name: "Beta" })
      seedRun(db, { id: "r1", challengeId: "ch-a", status: "running" })
      seedRun(db, { id: "r2", challengeId: "ch-b", status: "idle" })
      seedRun(db, { id: "r3", challengeId: "ch-a", status: "closed" })

      const getRow = () => {
        const r = db
          .select()
          .from(orchestrators)
          .where(eq(orchestrators.eventId, "evt-1"))
          .get()
        if (!r) throw new Error("orchestrator seed missing")
        return r
      }
      const ctx = buildOrchestratorToolContext({
        db,
        eventId: "evt-1",
        getRow,
        getSettings: flatSettings,
        runService: stubRunService(),
        resolveModelSelection: stubResolveModelSelection,
        containerConfig: stubContainerConfig,
      })

      const status = ctx.getStatus()
      expect(status.runs).toHaveLength(2) // closed r3 filtered out
      expect(status.maxConcurrentTargets).toBe(3)
      expect(status.runs.map((r) => r.id).sort()).toEqual(["r1", "r2"])
    } finally {
      close()
    }
  })

  function ctxFor(
    db: ReturnType<typeof createDatabase>["db"],
    eventId = "evt-1"
  ) {
    return buildOrchestratorToolContext({
      db,
      eventId,
      getRow: () =>
        db
          .select()
          .from(orchestrators)
          .where(eq(orchestrators.eventId, eventId))
          .get() ?? ({ maxConcurrentTargets: 1 } as never),
      getSettings: flatSettings,
      runService: stubRunService(),
      resolveModelSelection: stubResolveModelSelection,
      containerConfig: stubContainerConfig,
    })
  }

  test("getChallenge reports a missing or foreign challenge", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1", name: "Alpha" })
      seedEvent(db, "evt-2")
      seedChallenge(db, { id: "ch-x", eventId: "evt-2" })
      const ctx = ctxFor(db)
      const missing = ctx.getChallenge("nope")
      expect("reason" in missing && missing.reason).toBe("Challenge not found")
      const foreign = ctx.getChallenge("ch-x")
      expect("reason" in foreign && foreign.reason).toBe(
        "Challenge belongs to another event"
      )
      const detail = ctx.getChallenge("ch-a")
      expect("reason" in detail).toBe(false)
      expect((detail as { name: string }).name).toBe("Alpha")
    } finally {
      close()
    }
  })

  test("listRuns filters by challenge/status and scopes to the event", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedChallenge(db, { id: "ch-b", eventId: "evt-1" })
      seedRun(db, { id: "ra1", challengeId: "ch-a", status: "running" })
      seedRun(db, { id: "ra2", challengeId: "ch-a", status: "closed" })
      seedRun(db, { id: "rb1", challengeId: "ch-b", status: "idle" })
      seedEvent(db, "evt-2")
      seedChallenge(db, { id: "ch-x", eventId: "evt-2" })
      seedRun(db, { id: "rx", challengeId: "ch-x", status: "running" })
      const ctx = ctxFor(db)
      expect(
        ctx
          .listRuns()
          .map((r) => r.id)
          .sort()
      ).toEqual(["ra1", "ra2", "rb1"])
      expect(
        ctx
          .listRuns({ challengeId: "ch-a" })
          .map((r) => r.id)
          .sort()
      ).toEqual(["ra1", "ra2"])
      expect(ctx.listRuns({ status: "closed" }).map((r) => r.id)).toEqual([
        "ra2",
      ])
    } finally {
      close()
    }
  })

  test("messageRun honors the global cap when restoring a closed run", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      // Cap (from flatSettings) is 4; fill it.
      for (let i = 0; i < 4; i++)
        seedRun(db, {
          id: `r${i}`,
          challengeId: "ch-a",
          status: "running",
        })
      seedRun(db, { id: "rclosed", challengeId: "ch-a", status: "closed" })
      const ctx = ctxFor(db)
      const blocked = await ctx.messageRun("rclosed", { text: "go" })
      expect(blocked.reason).toMatch(/concurrency/i)
      // An idle run is already holding its slot → messages without the cap.
      seedRun(db, { id: "ridle", challengeId: "ch-a", status: "idle" })
      const ok = await ctx.messageRun("ridle", { text: "go" })
      expect(ok.reason).toBeUndefined()
    } finally {
      close()
    }
  })

  test("closeRun delegates and rejects an already-closed run", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-a", eventId: "evt-1" })
      seedRun(db, { id: "ridle", challengeId: "ch-a", status: "idle" })
      seedRun(db, { id: "rclosed", challengeId: "ch-a", status: "closed" })
      const ctx = ctxFor(db)
      expect((await ctx.closeRun("ridle")).status).toBe("closed")
      expect((await ctx.closeRun("rclosed")).reason).toMatch(/already closed/i)
    } finally {
      close()
    }
  })
})
