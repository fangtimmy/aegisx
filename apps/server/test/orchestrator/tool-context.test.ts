import { describe, expect, test } from "bun:test"
import type { MessageList } from "@aegisx/shared"
import { eq } from "drizzle-orm"
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
})
