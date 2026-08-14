import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import type { Context } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { events } from "../db/schema"
import { badRequest, jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import { EmptyInputSchema } from "../lib/schemas"
import { RunActionError } from "../run/errors"
import type { RunService } from "../run/service"
import { streamRun } from "../run/sse"

const enqueueInput = Type.Object(
  {
    orchestration: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    params: Type.Optional(Type.Unknown()),
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
  },
  { additionalProperties: false }
)

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
  options: { db: Database; runService: RunService }
) {
  const { db, runService } = options

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
    const queue = runService.queue()
    return c.json({
      items: queue.list(eventId),
      state: queue.stateOf(eventId),
    })
  })

  app.post(
    "/api/events/:eventId/queue/pause",
    validateJson(emptyInput),
    (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      // Blocks future launches only — running runs keep going (pause ≠ kill).
      runService.queue().pause(eventId)
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
      runService.queue().resume(eventId)
      runService.queue().scheduleDrain()
      return c.json({ state: "running" })
    }
  )

  app.post(
    "/api/events/:eventId/queue",
    validateJson(enqueueInput),
    async (c) => {
      const eventId = c.req.param("eventId")
      const miss = requireEvent(c, eventId)
      if (miss) return miss
      const body = c.req.valid("json")
      // Enqueue needs a challengeId; require it via query for the HTTP path
      // (the scheduler tool passes it inline). The body carries the rest.
      const challengeId = c.req.query("challengeId") ?? ""
      if (!challengeId) {
        return badRequest(
          c,
          "invalid_request",
          "challengeId query parameter is required"
        )
      }
      const item = runService.queue().enqueue({
        eventId,
        challengeId,
        orchestration: body.orchestration ?? "classic",
        params: body.params as Record<string, unknown> | undefined,
        prompt: body.prompt,
        timeoutMs: body.timeoutMs,
        source: "manual",
      })
      await runService.queue().drainOnce()
      return c.json(item, 201)
    }
  )

  app.delete("/api/events/:eventId/queue/:itemId", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    try {
      runService.queue().remove(c.req.param("itemId"))
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
      runService.queue().clear(eventId)
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
      runService.queue().reorder(eventId, c.req.valid("json").itemIds)
      return c.json({ items: runService.queue().list(eventId) })
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
          runService.queue().update(c.req.param("itemId"), {
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

  // --- scheduler (event-scoped run) ---------------------------------------

  app.get("/api/events/:eventId/scheduler", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    return c.json({
      config: runService.getSchedulerConfig(eventId),
      run: runService.getSchedulerRun(eventId) ?? null,
      status: runService.getStatus(eventId),
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
      return c.json(runService.upsertSchedulerConfig({ eventId, ...body }))
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
          await runService.startScheduler(eventId, { reset: reset ?? false }),
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
      const sched = runService.getSchedulerRun(eventId)
      if (!sched) return notFound(c, "No scheduler run for this event")
      try {
        return c.json(await runService.stop(sched.id))
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
      const sched = runService.getSchedulerRun(eventId)
      if (!sched) return notFound(c, "No scheduler run for this event")
      try {
        return c.json(await runService.closeRun(sched.id))
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
        return c.json(await runService.pauseScheduler(eventId))
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
        return c.json(await runService.resumeScheduler(eventId))
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
      const sched = runService.getSchedulerRun(eventId)
      if (!sched) return notFound(c, "No scheduler run for this event")
      try {
        const body = c.req.valid("json")
        return c.json(
          await runService.sendMessage(sched.id, {
            text: body.text,
            deliverAs: body.deliverAs,
          })
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.get("/api/events/:eventId/scheduler/messages", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    const sched = runService.getSchedulerRun(eventId)
    if (!sched) return notFound(c, "No scheduler run for this event")
    const afterRaw = Number.parseInt(c.req.query("after") ?? "0", 10)
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    return c.json(runService.listMessages(sched.id, { after }))
  })

  app.get("/api/events/:eventId/scheduler/stream", (c) => {
    const eventId = c.req.param("eventId")
    const miss = requireEvent(c, eventId)
    if (miss) return miss
    const sched = runService.getSchedulerRun(eventId)
    if (!sched) return notFound(c, "No scheduler run for this event")
    return streamRun(c, runService, sched.id)
  })
}

function runError(c: Context, error: unknown) {
  if (!(error instanceof RunActionError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found"
      ? 404
      : error.code === "launch_failed"
        ? 500
        : error.code === "capacity"
          ? 429
          : 409
  )
}
