import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"

import { createApp } from "../../src/app"
import { createDatabase, type Database } from "../../src/db"
import { domainEvents, queueState, spawnQueue } from "../../src/db/schema"
import { emitDomainEvent } from "../../src/run/domain-events/store"
import { seedChallenge, seedEvent } from "../helpers"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function setupDb(): { db: Database; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-domain-events-"))
  const { db, sqlite, releaseLock } = createDatabase(dir)
  tempDirs.push(dir)
  return {
    db,
    close: () => {
      sqlite.close()
      releaseLock()
    },
  }
}

function stream(db: Database) {
  return db.select().from(domainEvents).all()
}

// Deliberately malformed payloads for the validator tests — the assertion is
// the point.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const broken = (payload: Record<string, unknown>) => payload as never

describe("domain event store", () => {
  test("append + project in one transaction: the queue row and the fact land together", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const { id, applied } = emitDomainEvent(db, {
        type: "queue.enqueued",
        eventId: "evt-1",
        challengeId: "ch-1",
        actor: { kind: "user" },
        payload: {
          itemId: "item-1",
          ord: 1,
          challengeId: "ch-1",
          params: { model: "m" },
          timeoutMs: null,
          prompt: "pwn it",
          source: "manual",
        },
      })
      expect(applied).toBe(true)
      const row = db
        .select()
        .from(spawnQueue)
        .where(eq(spawnQueue.id, "item-1"))
        .get()
      expect(row).toMatchObject({
        id: "item-1",
        eventId: "evt-1",
        ord: 1,
        status: "pending",
        agentId: null,
        prompt: "pwn it",
      })
      expect(JSON.parse(row!.params)).toEqual({ model: "m" })
      const fact = stream(db)[0]
      expect(fact).toMatchObject({
        id,
        type: "queue.enqueued",
        eventId: "evt-1",
        challengeId: "ch-1",
        actorKind: "user",
        actorId: null,
        agentId: null,
        causationId: null,
      })
      expect(JSON.parse(fact.payload)).toMatchObject({ itemId: "item-1" })
    } finally {
      close()
    }
  })

  test("a projection failure rolls the whole append back (atomicity)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      // challengeId references a missing challenge — the spawn_queue FK insert
      // fails and must take the event row down with it.
      expect(() =>
        emitDomainEvent(db, {
          type: "queue.enqueued",
          eventId: "evt-1",
          challengeId: "ch-missing",
          actor: { kind: "user" },
          payload: {
            itemId: "item-x",
            ord: 1,
            challengeId: "ch-missing",
            params: {},
            timeoutMs: null,
            prompt: "",
            source: "manual",
          },
        })
      ).toThrow()
      expect(stream(db)).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("invalid payloads are rejected before anything is written", () => {
    const { db, close } = setupDb()
    try {
      expect(() =>
        emitDomainEvent(db, {
          type: "queue.item_failed",
          eventId: "evt-1",
          actor: { kind: "system", actorId: "drainer" },
          payload: broken({ itemId: 7, error: "boom" }),
        })
      ).toThrow(/item/)
      expect(() =>
        emitDomainEvent(db, {
          type: "queue.item_failed",
          eventId: "evt-1",
          actor: { kind: "system", actorId: "drainer" },
          // Unknown field — typos cannot silently enter the stream.
          payload: broken({ itemId: "i", error: "boom", err0r: "x" }),
        })
      ).toThrow(/unknown field/)
      expect(() =>
        emitDomainEvent(db, {
          type: "queue.item_failed",
          eventId: "evt-1",
          actor: { kind: "system", actorId: "drainer" },
          payload: broken({ itemId: "i" }),
        })
      ).toThrow(/missing field/)
      expect(stream(db)).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("guarded projections report applied=false without blocking the fact", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Launching a non-pending item: the guarded update misses, the fact
      // stays (the caller decides whether that means superseded).
      const { applied } = emitDomainEvent(db, {
        type: "queue.launched",
        eventId: "evt-1",
        challengeId: "ch-1",
        agentId: "a-1",
        actor: { kind: "system", actorId: "drainer" },
        payload: { itemId: "item-gone", agentId: "a-1" },
      })
      expect(applied).toBe(false)
      expect(stream(db)).toHaveLength(1)
    } finally {
      close()
    }
  })

  test("queue.paused/resumed project into queue_state (upsert)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      emitDomainEvent(db, {
        type: "queue.paused",
        eventId: "evt-1",
        actor: { kind: "system", actorId: "boot-recovery" },
        payload: { source: "boot" },
      })
      expect(
        db
          .select()
          .from(queueState)
          .where(eq(queueState.eventId, "evt-1"))
          .get()
      ).toMatchObject({ status: "paused" })
      emitDomainEvent(db, {
        type: "queue.resumed",
        eventId: "evt-1",
        actor: { kind: "user" },
        payload: { source: "manual" },
      })
      expect(
        db
          .select()
          .from(queueState)
          .where(eq(queueState.eventId, "evt-1"))
          .get()
      ).toMatchObject({ status: "running" })
      expect(stream(db).map((row) => row.type)).toEqual([
        "queue.paused",
        "queue.resumed",
      ])
    } finally {
      close()
    }
  })

  test("emission inside an open transaction rolls back with it (savepoint)", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      expect(() =>
        db.transaction((tx) => {
          tx.insert(spawnQueue)
            .values({
              id: "item-n",
              eventId: "evt-1",
              ord: 1,
              challengeId: "ch-1",
              params: "{}",
              prompt: "",
              source: "manual",
              createdAt: "t",
              updatedAt: "t",
            })
            .run()
          emitDomainEvent(db, {
            type: "queue.paused",
            eventId: "evt-1",
            actor: { kind: "user" },
            payload: { source: "manual" },
          })
          throw new Error("caller aborts the outer transaction")
        })
      ).toThrow("caller aborts")
      // The savepoint-wrapped fact went down with the outer transaction.
      expect(stream(db)).toHaveLength(0)
      expect(
        db.select().from(spawnQueue).where(eq(spawnQueue.id, "item-n")).get()
      ).toBeUndefined()
    } finally {
      close()
    }
  })

  test("actorFromPrincipal-free emission records the agent actor verbatim", () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      emitDomainEvent(db, {
        type: "flag.accepted",
        eventId: "evt-1",
        challengeId: "ch-1",
        agentId: "a-1",
        actor: { kind: "agent", agentId: "a-1" },
        payload: {
          flagId: "f-1",
          value: "flag{x}",
          source: "agent",
          submitter: "a-1",
          tier: "first",
          remoteSolved: true,
        },
      })
      const fact = stream(db)[0]
      expect(fact).toMatchObject({
        type: "flag.accepted",
        actorKind: "agent",
        actorId: "a-1",
        agentId: "a-1",
      })
    } finally {
      close()
    }
  })
})

describe("decision log API", () => {
  function createTestApp() {
    const dir = mkdtempSync(join(tmpdir(), "aegisx-decisions-"))
    tempDirs.push(dir)
    const instance = createApp({ dataDir: dir })
    closeDatabases.push(instance.close)
    return instance
  }

  test("serves the decision-log type set newest-first with before-id paging", async () => {
    const instance = createTestApp()
    const { db } = instance
    seedEvent(db, "evt-1")
    seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
    const ids: number[] = []
    for (let n = 1; n <= 3; n++) {
      ids.push(
        emitDomainEvent(db, {
          type: "queue.enqueued",
          eventId: "evt-1",
          challengeId: "ch-1",
          actor: { kind: "user" },
          payload: {
            itemId: `item-${n}`,
            ord: n,
            challengeId: "ch-1",
            params: {},
            timeoutMs: null,
            prompt: "",
            source: "manual",
          },
        }).id
      )
    }
    // A non-decision-log fact: never surfaces in the view.
    emitDomainEvent(db, {
      type: "channel.posted",
      eventId: "evt-1",
      actor: { kind: "user" },
      payload: { channelKey: "orch:evt-1", messageId: 1, authorType: "user" },
    })

    const response = await instance.app.request("/api/events/evt-1/decisions")
    expect(response.status).toBe(200)
    const page = await response.json()
    expect(page.items.map((item: { id: number }) => item.id)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ])
    expect(page.items[0]).toMatchObject({
      type: "queue.enqueued",
      eventId: "evt-1",
      challengeId: "ch-1",
      actorKind: "user",
    })
    expect(page.nextBeforeId).toBeNull()

    const paged = await instance.app.request(
      `/api/events/evt-1/decisions?limit=2`
    )
    const page2 = await paged.json()
    expect(page2.items.map((item: { id: number }) => item.id)).toEqual([
      ids[2],
      ids[1],
    ])
    expect(page2.nextBeforeId).toBe(ids[1])

    const tail = await instance.app.request(
      `/api/events/evt-1/decisions?limit=2&beforeId=${page2.nextBeforeId}`
    )
    const page3 = await tail.json()
    expect(page3.items.map((item: { id: number }) => item.id)).toEqual([ids[0]])
    expect(page3.nextBeforeId).toBeNull()
  })

  test("other events' facts and unknown events stay out", async () => {
    const instance = createTestApp()
    const { db } = instance
    seedEvent(db, "evt-1")
    seedEvent(db, "evt-2")
    seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
    seedChallenge(db, { id: "ch-2", eventId: "evt-2" })
    emitDomainEvent(db, {
      type: "queue.enqueued",
      eventId: "evt-1",
      challengeId: "ch-1",
      actor: { kind: "user" },
      payload: {
        itemId: "item-1",
        ord: 1,
        challengeId: "ch-1",
        params: {},
        timeoutMs: null,
        prompt: "",
        source: "manual",
      },
    })
    emitDomainEvent(db, {
      type: "queue.enqueued",
      eventId: "evt-2",
      challengeId: "ch-2",
      actor: { kind: "user" },
      payload: {
        itemId: "item-2",
        ord: 1,
        challengeId: "ch-2",
        params: {},
        timeoutMs: null,
        prompt: "",
        source: "manual",
      },
    })
    const mine = await instance.app.request("/api/events/evt-1/decisions")
    const minePage = await mine.json()
    expect(minePage.items).toHaveLength(1)

    const missing = await instance.app.request("/api/events/evt-x/decisions")
    expect(missing.status).toBe(404)
  })

  test("the projection writes are the only queue_state rows", async () => {
    const { db, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      const states = () =>
        db
          .select()
          .from(queueState)
          .where(and(eq(queueState.eventId, "evt-1")))
          .all()
      expect(states()).toHaveLength(0)
      emitDomainEvent(db, {
        type: "queue.paused",
        eventId: "evt-1",
        actor: { kind: "user" },
        payload: { source: "manual" },
      })
      expect(states()).toHaveLength(1)
    } finally {
      close()
    }
  })
})
