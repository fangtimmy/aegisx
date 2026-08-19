import type {
  ActivityItem,
  ActivitySnapshot,
  ActivityKind,
} from "@aegisx/shared"
import { desc, eq, isNotNull } from "drizzle-orm"
import type { Hono } from "hono"

import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challenges,
  events,
  spawnQueue,
} from "../db/schema"

/** Per-source fetch window before the merge — the global limit is applied
 * after sorting, so each source only needs to cover the window. */
const PER_SOURCE_LIMIT = 200
const SUMMARY_MAX = 120

function truncate(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, SUMMARY_MAX)}…` : value
}

/** Union the per-source timestamped facts into one activity feed, newest
 * first. Pure query derivation — nothing is persisted here. */
export function listActivity(db: Database, limit: number): ActivitySnapshot {
  const items: ActivityItem[] = []

  const eventNames = new Map(
    db
      .select({ id: events.id, name: events.name })
      .from(events)
      .all()
      .map((row) => [row.id, row.name])
  )
  const eventName = (id: string) => eventNames.get(id) ?? ""

  for (const row of db
    .select({
      id: challengeFlags.id,
      time: challengeFlags.createdAt,
      flag: challengeFlags.flag,
      challengeId: challengeFlags.challengeId,
      challengeName: challenges.name,
      eventId: challenges.eventId,
      agentId: challengeFlags.agentId,
    })
    .from(challengeFlags)
    .innerJoin(challenges, eq(challengeFlags.challengeId, challenges.id))
    .where(eq(challengeFlags.status, "accepted"))
    .orderBy(desc(challengeFlags.createdAt))
    .limit(PER_SOURCE_LIMIT)
    .all()) {
    items.push({
      id: `flag:${row.id}`,
      kind: "flag",
      time: row.time,
      eventId: row.eventId,
      eventName: eventName(row.eventId),
      challengeId: row.challengeId,
      challengeName: row.challengeName,
      agentId: row.agentId,
      agentStatus: null,
      summary: null,
      flag: row.flag,
    })
  }

  for (const row of db
    .select({
      id: agents.id,
      time: agents.createdAt,
      eventId: agents.eventId,
      challengeId: agents.challengeId,
      challengeName: challenges.name,
      source: agents.source,
    })
    .from(agents)
    .leftJoin(challenges, eq(agents.challengeId, challenges.id))
    .orderBy(desc(agents.createdAt))
    .limit(PER_SOURCE_LIMIT)
    .all()) {
    items.push({
      id: `agent:${row.id}:spawn`,
      kind: "agentSpawn",
      time: row.time,
      eventId: row.eventId,
      eventName: eventName(row.eventId),
      challengeId: row.challengeId,
      challengeName: row.challengeName ?? null,
      agentId: row.id,
      agentStatus: null,
      summary: row.source,
      flag: null,
    })
  }

  for (const row of db
    .select({
      id: agents.id,
      time: agents.completedAt,
      eventId: agents.eventId,
      challengeId: agents.challengeId,
      challengeName: challenges.name,
      status: agents.status,
      summary: agents.summary,
      error: agents.error,
    })
    .from(agents)
    .leftJoin(challenges, eq(agents.challengeId, challenges.id))
    .where(isNotNull(agents.completedAt))
    .orderBy(desc(agents.completedAt))
    .limit(PER_SOURCE_LIMIT)
    .all()) {
    items.push({
      id: `agent:${row.id}:end`,
      kind: "agentEnd",
      time: row.time!,
      eventId: row.eventId,
      eventName: eventName(row.eventId),
      challengeId: row.challengeId,
      challengeName: row.challengeName ?? null,
      agentId: row.id,
      agentStatus: row.status,
      summary:
        (row.summary ?? row.error) ? truncate(row.summary ?? row.error!) : null,
      flag: null,
    })
  }

  for (const row of db
    .select({
      id: agents.id,
      time: agents.lastTimeoutAt,
      eventId: agents.eventId,
      challengeId: agents.challengeId,
      challengeName: challenges.name,
    })
    .from(agents)
    .leftJoin(challenges, eq(agents.challengeId, challenges.id))
    .where(isNotNull(agents.lastTimeoutAt))
    .orderBy(desc(agents.lastTimeoutAt))
    .limit(PER_SOURCE_LIMIT)
    .all()) {
    items.push({
      id: `agent:${row.id}:timeout`,
      kind: "timeout",
      time: row.time!,
      eventId: row.eventId,
      eventName: eventName(row.eventId),
      challengeId: row.challengeId,
      challengeName: row.challengeName ?? null,
      agentId: row.id,
      agentStatus: null,
      summary: null,
      flag: null,
    })
  }

  for (const row of db
    .select({
      id: spawnQueue.id,
      time: spawnQueue.updatedAt,
      eventId: spawnQueue.eventId,
      challengeId: spawnQueue.challengeId,
      challengeName: challenges.name,
      error: spawnQueue.error,
    })
    .from(spawnQueue)
    .innerJoin(challenges, eq(spawnQueue.challengeId, challenges.id))
    .where(eq(spawnQueue.status, "failed"))
    .orderBy(desc(spawnQueue.updatedAt))
    .limit(PER_SOURCE_LIMIT)
    .all()) {
    items.push({
      id: `queue:${row.id}`,
      kind: "queueFailed",
      time: row.time,
      eventId: row.eventId,
      eventName: eventName(row.eventId),
      challengeId: row.challengeId,
      challengeName: row.challengeName,
      agentId: null,
      agentStatus: null,
      summary: row.error ? truncate(row.error) : null,
      flag: null,
    })
  }

  items.sort((left, right) => right.time.localeCompare(left.time))
  return { items: items.slice(0, limit) }
}

export function registerActivityRoutes(app: Hono, options: { db: Database }) {
  const { db } = options
  app.get("/api/activity", (c) => {
    const parsed = Number(c.req.query("limit"))
    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), 200)
        : 100
    return c.json(listActivity(db, limit))
  })
}
