import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import type { Context } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { events } from "../db/schema"
import { principalOf } from "../infrastructure/agent-auth"
import { notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import { EmptyInputSchema } from "../lib/schemas"
import { runActionError as runError } from "../run/errors"
import type { AgentService } from "../run/service"

const reorderInput = Type.Object(
  { itemIds: Type.Array(Type.String({ minLength: 1 })) },
  { additionalProperties: false }
)

const patchQueueInput = Type.Object(
  {
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
)

const schedulerConfigInput = Type.Object(
  {
    modelId: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])
    ),
    instruction: Type.Optional(Type.String({ maxLength: 20_000 })),
    maxConcurrentTargets: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false }
)

const schedulerMessageInput = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 20_000 }),
    deliverAs: Type.Optional(
      Type.Union([Type.Literal("steer"), Type.Literal("followUp")])
    ),
  },
  { additionalProperties: false }
)

/** W3.2: `reset: true` deletes the closed scheduler run (cascade agents /
 * sessions) and starts fresh; default (false) cold-restores keeping memory. */
const schedulerStartInput = Type.Object(
  { reset: Type.Optional(Type.Boolean()) },
  { additionalProperties: false }
)

const emptyInput = EmptyInputSchema

export function registerSchedulerRoutes(
  app: Hono,
  options: { db: Database; agentService: AgentService }
) {
  const { db, agentService } = options

  function requireEvent(c: Context, eventId: string) {
    const event = db.select().from(events).where(eq(events.id, eventId)).get()
    if (!event) return notFound(c, "Event not found")
    return null
  }

  // --- task queue ----------------------------------------------------------

  app.get("/api/events/:eventId/queue", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    const queue = agentService.queue()
    return c.json({
      items: queue.list(eventId),
      state: queue.stateOf(eventId),
    })
  })

  /** Live scheduler-DM digest snapshot (the scheduler DM view's status
   * header): unread backlog, silence/stall timers, hold state + the channel
   * id for the timeline. No live digest (no scheduler run) → live:false. */
  app.get("/api/events/:eventId/inbox", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    return c.json(agentService.inboxSnapshot(eventId))
  })

  /** Hold delivery: the inbox keeps collecting silently but flushes nothing —
   * the orchestrator stays idle. Resume flushes the backlog in one digest.
   * In-memory only (a scheduler-run rebuild resets it); no live inbox → no-op. */
  app.post(
    "/api/events/:eventId/inbox/pause",
    validateJson(emptyInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      agentService.setInboxDeliveryPaused(eventId, true)
      return c.json({ deliveryPaused: true })
    }
  )

  app.post(
    "/api/events/:eventId/inbox/resume",
    validateJson(emptyInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      agentService.setInboxDeliveryPaused(eventId, false)
      return c.json({ deliveryPaused: false })
    }
  )

  app.post(
    "/api/events/:eventId/queue/pause",
    validateJson(emptyInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      // Blocks future launches only — running runs keep going (pause ≠ kill).
      agentService
        .queue()
        .pause(eventId, principalOf(c) ? "scheduler" : "manual")
      return c.json({ state: "paused" })
    }
  )

  app.post(
    "/api/events/:eventId/queue/resume",
    validateJson(emptyInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      agentService
        .queue()
        .resume(eventId, principalOf(c) ? "scheduler" : "manual")
      agentService.queue().scheduleDrain()
      return c.json({ state: "running" })
    }
  )

  app.delete("/api/events/:eventId/queue/:itemId", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    try {
      agentService.queue().remove(c.req.param("itemId"))
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post(
    "/api/events/:eventId/queue/clear",
    validateJson(emptyInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      agentService.queue().clear(eventId)
      return c.body(null, 204)
    }
  )

  app.post(
    "/api/events/:eventId/queue/reorder",
    validateJson(reorderInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      agentService.queue().reorder(eventId, c.req.valid("json").itemIds)
      return c.json({ items: agentService.queue().list(eventId) })
    }
  )

  app.patch(
    "/api/events/:eventId/queue/:itemId",
    validateJson(patchQueueInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      try {
        const body = c.req.valid("json")
        return c.json(
          agentService.queue().update(c.req.param("itemId"), {
            ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
            ...(body.timeoutMs !== undefined
              ? { timeoutMs: body.timeoutMs }
              : {}),
            ...(body.params !== undefined
              ? { params: body.params as Record<string, unknown> }
              : {}),
          })
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // --- scheduler (the event's orchestrator agent) -------------------------

  app.get("/api/events/:eventId/scheduler", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    return c.json({
      config: agentService.getSchedulerConfig(eventId),
      agent: agentService.getSchedulerAgent(eventId) ?? null,
      status: agentService.getStatus(eventId),
    })
  })

  app.patch(
    "/api/events/:eventId/scheduler",
    validateJson(schedulerConfigInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      const body = c.req.valid("json")
      return c.json(agentService.upsertSchedulerConfig({ eventId, ...body }))
    }
  )

  app.post(
    "/api/events/:eventId/scheduler/start",
    validateJson(schedulerStartInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      try {
        const { reset } = c.req.valid("json")
        return c.json(
          await agentService.startScheduler(eventId, { reset: reset ?? false }),
          201
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/scheduler/stop",
    validateJson(emptyInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      const sched = agentService.getSchedulerAgent(eventId)
      if (!sched) return notFound(c, "No scheduler agent for this event")
      try {
        return c.json(await agentService.stopAgent(sched.id))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/scheduler/close",
    validateJson(emptyInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      try {
        return c.json(await agentService.closeScheduler(eventId))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // W3.1: pause = paused flag + stop (abort the current turn, container warm);
  // resume = clear flag + re-sync message to the orchestrator. Both write the
  // flag even with no scheduler run (presets the next start).
  app.post(
    "/api/events/:eventId/scheduler/pause",
    validateJson(emptyInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      try {
        return c.json(await agentService.pauseScheduler(eventId))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/scheduler/resume",
    validateJson(emptyInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      try {
        return c.json(await agentService.resumeScheduler(eventId))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/scheduler/message",
    validateJson(schedulerMessageInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      const sched = agentService.getSchedulerAgent(eventId)
      if (!sched) return notFound(c, "No scheduler agent for this event")
      try {
        const body = c.req.valid("json")
        return c.json(
          await agentService.sendMessage(sched.id, {
            text: body.text,
            deliverAs: body.deliverAs,
          })
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )
}
