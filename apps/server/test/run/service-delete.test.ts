import { describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { agents, spawnQueue } from "../../src/db/schema"
import { challengeContainerName } from "../../src/run/workspace-resolver"
import {
  makeAgentService,
  seedAgent,
  seedChallenge,
  stubHostAgentSession,
  USER,
} from "../helpers"

const now = () => new Date().toISOString()

function makeService() {
  const h = makeAgentService({
    createHost: mock(async () => stubHostAgentSession()),
  })
  return { h, db: h.db, dir: h.dir, service: h.service, killed: h.stubs.killed }
}

describe("deleteAgent", () => {
  test("a queue-launched agent's running item settles done — nothing sticks in the visible queue", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      seedAgent(db, {
        id: "ag-q",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "running",
        queueItemId: "q-1",
      })
      db.insert(spawnQueue)
        .values({
          id: "q-1",
          eventId: "evt-1",
          ord: 1,
          challengeId: "ch-1",
          params: "{}",
          prompt: "",
          source: "manual",
          status: "running",
          agentId: "ag-q",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      await service.delete("ag-q", USER)

      expect(
        db.select().from(agents).where(eq(agents.id, "ag-q")).get()
      ).toBeUndefined()
      // The item went through the terminal funnel (terminalize → markDone)
      // instead of sticking running forever.
      expect(service.queue()?.list("evt-1", USER)).toEqual([])
    } finally {
      await made.h.close()
    }
  })

  test("deleting a manual agent leaves queue items untouched", async () => {
    const made = makeService()
    try {
      const { db, service } = made
      seedAgent(db, {
        id: "ag-m",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "idle",
      })

      await service.delete("ag-m", USER)

      expect(
        db.select().from(agents).where(eq(agents.id, "ag-m")).get()
      ).toBeUndefined()
      expect(service.queue()?.list("evt-1", USER)).toEqual([])
    } finally {
      await made.h.close()
    }
  })
})

describe("workspace deletion (teardown of the cached context + container)", () => {
  test("deleteChallengeWorkspace evicts the context + container; a fresh spawn rebuilds from scratch", async () => {
    const made = makeService()
    try {
      const { db, dir, service, killed } = made
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      const challengesRoot = join(dir, "events", "evt-1", "challenges")
      expect(existsSync(join(challengesRoot, "ch-1", "workspace"))).toBe(true)
      expect(service.containerLifecycle.registered("ch-1")).toBe(true)

      service.deleteChallengeWorkspace("evt-1", "ch-1")

      // The tree, the registry entry, and the container itself are gone.
      expect(existsSync(join(challengesRoot, "ch-1"))).toBe(false)
      expect(service.containerLifecycle.registered("ch-1")).toBe(false)
      expect(killed).toContain(challengeContainerName("ch-1"))

      // A fresh agent on another challenge rebuilds everything cleanly —
      // nothing cached for the deleted workspace is reused or crashes.
      const fresh = await service.spawn(
        {
          eventId: "evt-1",
          challengeId: "ch-2",
        },
        USER
      )
      expect(fresh.challengeId).toBe("ch-2")
      expect(existsSync(join(challengesRoot, "ch-2", "workspace"))).toBe(true)
      expect(service.containerLifecycle.registered("ch-2")).toBe(true)
    } finally {
      await made.h.close()
    }
  })

  test("deleteEventWorkspaces evicts every challenge context + the orchestrator context", async () => {
    const made = makeService()
    try {
      const { db, dir, service, killed } = made
      seedChallenge(db, { id: "ch-2", eventId: "evt-1" })
      await service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      await service.spawn({ eventId: "evt-1", challengeId: "ch-2" }, USER)

      service.deleteEventWorkspaces("evt-1")

      const eventsRoot = join(dir, "events", "evt-1")
      expect(existsSync(join(eventsRoot, "challenges", "ch-1"))).toBe(false)
      expect(existsSync(join(eventsRoot, "challenges", "ch-2"))).toBe(false)
      expect(existsSync(join(eventsRoot, "orchestrator"))).toBe(false)
      expect(service.containerLifecycle.registered("ch-1")).toBe(false)
      expect(service.containerLifecycle.registered("ch-2")).toBe(false)
      expect(killed).toContain(challengeContainerName("ch-1"))
      expect(killed).toContain(challengeContainerName("ch-2"))
    } finally {
      await made.h.close()
    }
  })
})
