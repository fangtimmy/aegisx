import { isRecord } from "@aegisx/shared"
import type {
  DecisionLogEntry,
  DecisionLogPage,
} from "@aegisx/shared/domain-events"
import { and, desc, eq, inArray, lt } from "drizzle-orm"
import type { Hono } from "hono"

import type { Database } from "../../db"
import { domainEvents, events } from "../../db/schema"
import { principalOf } from "../../infrastructure/agent-auth"
import { notFound } from "../../infrastructure/http-errors"
import { assertMayTouchEvent } from "../principal-scope"
import { DECISION_LOG_EVENT_TYPES } from "./registry"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** GET /api/events/:eventId/decisions — the event's decision log: domain
 * events from the decision-log type set, newest first, paged by the global
 * id cursor (`beforeId` → `nextBeforeId`). */
export function registerDomainEventRoutes(
  app: Hono,
  options: { db: Database }
) {
  const { db } = options

  app.get("/api/events/:eventId/decisions", (c) => {
    const eventId = c.req.param("eventId")
    if (
      !db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, eventId))
        .get()
    ) {
      return notFound(c, "Event not found")
    }
    assertMayTouchEvent(principalOf(c), eventId)
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10)
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
      : DEFAULT_LIMIT
    const beforeRaw = Number.parseInt(c.req.query("beforeId") ?? "", 10)
    const beforeId = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : 0

    const rows = db
      .select({
        id: domainEvents.id,
        type: domainEvents.type,
        eventId: domainEvents.eventId,
        challengeId: domainEvents.challengeId,
        agentId: domainEvents.agentId,
        actorKind: domainEvents.actorKind,
        actorId: domainEvents.actorId,
        causationId: domainEvents.causationId,
        payload: domainEvents.payload,
        createdAt: domainEvents.createdAt,
      })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.eventId, eventId),
          inArray(domainEvents.type, DECISION_LOG_EVENT_TYPES),
          ...(beforeId > 0 ? [lt(domainEvents.id, beforeId)] : [])
        )
      )
      .orderBy(desc(domainEvents.id))
      .limit(limit + 1)
      .all()

    const hasMore = rows.length > limit
    const items: DecisionLogEntry[] = rows.slice(0, limit).map((row) => {
      let payload: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(row.payload)
        if (isRecord(parsed)) payload = parsed
      } catch {
        // A row we cannot parse still surfaces — payload stays empty.
      }
      return { ...row, payload }
    })
    const page: DecisionLogPage = {
      items,
      nextBeforeId:
        hasMore && items.length > 0 ? items[items.length - 1].id : null,
    }
    return c.json(page)
  })
}
