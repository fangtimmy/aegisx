import type { Hono } from "hono"
import { streamText } from "hono/streaming"
import { Type } from "typebox"

import { validateJson } from "../infrastructure/validation"
import { EmptyInputSchema } from "../lib/schemas"
import { PlatformActionError, platformActionHttpError } from "./errors"
import type { createPlatformService } from "./service"

type PlatformService = ReturnType<typeof createPlatformService>

const platformType = Type.Union([
  Type.Literal("ctfd"),
  Type.Literal("ret2shell"),
  Type.Literal("a1ctf"),
  Type.Literal("tsecbench"),
])

const connectionInput = Type.Object(
  {
    type: platformType,
    baseUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
    credential: Type.String({ minLength: 1, maxLength: 20_000 }),
  },
  { additionalProperties: false }
)

const bindingInput = Type.Object(
  {
    type: platformType,
    baseUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
    credential: Type.String({ minLength: 1, maxLength: 20_000 }),
    remoteEventId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false }
)

const emptyInput = EmptyInputSchema
const importInput = Type.Object(
  {
    remoteIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      minItems: 1,
      maxItems: 2_000,
    }),
  },
  { additionalProperties: false }
)

export function registerPlatformRoutes(app: Hono, service: PlatformService) {
  app.post(
    "/api/platform/events/discover",
    validateJson(connectionInput),
    async (c) => {
      try {
        return c.json({
          items: await service.listRemoteEvents(c.req.valid("json")),
        })
      } catch (error) {
        return platformActionHttpError(c, error)
      }
    }
  )

  app.post(
    "/api/platform/connection/test",
    validateJson(connectionInput),
    async (c) => {
      try {
        return c.json(await service.testConnection(c.req.valid("json")))
      } catch (error) {
        return platformActionHttpError(c, error)
      }
    }
  )

  app.put(
    "/api/events/:eventId/platform",
    validateJson(bindingInput),
    async (c) => {
      try {
        const result = await service.bind(
          c.req.param("eventId"),
          c.req.valid("json")
        )
        return c.json(result)
      } catch (error) {
        return platformActionHttpError(c, error)
      }
    }
  )

  app.post("/api/events/:eventId/platform/test", async (c) => {
    try {
      await service.testBoundConnection(c.req.param("eventId"))
      return c.json({ ok: true })
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  app.delete("/api/events/:eventId/platform", async (c) => {
    try {
      await service.detach(c.req.param("eventId"))
      return c.body(null, 204)
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  app.post("/api/events/:eventId/platform/challenges/discover", async (c) => {
    try {
      return c.json(await service.discoverChallenges(c.req.param("eventId")))
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  app.post(
    "/api/events/:eventId/platform/challenges/sync",
    validateJson(importInput),
    async (c) => {
      try {
        return c.json(
          await service.syncChallenges(
            c.req.param("eventId"),
            c.req.valid("json").remoteIds
          )
        )
      } catch (error) {
        return platformActionHttpError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/platform/challenges/sync/stream",
    validateJson(importInput),
    (c) =>
      streamText(c, async (stream) => {
        try {
          const result = await service.syncChallenges(
            c.req.param("eventId"),
            c.req.valid("json").remoteIds,
            async (event) => {
              if (event.type === "progress") {
                await stream.writeln(
                  JSON.stringify({
                    type: "progress",
                    progress: event.progress,
                  })
                )
                return
              }
              await stream.writeln(
                JSON.stringify({
                  type: "item",
                  item: event.item,
                  completed: event.completed,
                  total: event.total,
                })
              )
            }
          )
          await stream.writeln(
            JSON.stringify({
              type: "complete",
              syncedAt: result.syncedAt,
              total: result.results.length,
            })
          )
        } catch (error) {
          await stream.writeln(
            JSON.stringify({
              type: "error",
              message:
                error instanceof PlatformActionError
                  ? error.message
                  : "Challenge sync failed",
            })
          )
        }
      })
  )

  app.get("/api/challenges/:challengeId/target", async (c) => {
    try {
      return c.json(
        await service.targetAction(c.req.param("challengeId"), "get")
      )
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  app.delete("/api/challenges/:challengeId/target", async (c) => {
    try {
      await service.ignoreTarget(c.req.param("challengeId"))
      return c.body(null, 204)
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  for (const action of ["start", "extend", "stop"] as const) {
    app.post(
      `/api/challenges/:challengeId/target/${action}`,
      validateJson(emptyInput),
      async (c) => {
        try {
          return c.json(
            await service.targetAction(c.req.param("challengeId"), action)
          )
        } catch (error) {
          return platformActionHttpError(c, error)
        }
      }
    )
  }
}
