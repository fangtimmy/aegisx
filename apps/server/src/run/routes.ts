import { eq } from "drizzle-orm"
import type { Context, Hono } from "hono"
import { Type } from "typebox"

import type { createDatabase } from "../db"
import { challenges } from "../db/schema"
import { badRequest, jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { EmptyInputSchema, ThinkingLevelSchema } from "../lib/schemas"
import { listPlugins } from "../orchestration/registry"
import { platformActionHttpError } from "../platforms/errors"
import { RunActionError } from "./errors"
import type { RunService } from "./service"
import { streamRun } from "./sse"

type Database = ReturnType<typeof createDatabase>["db"]

/** Manual enqueue body (spec §10: POST /api/challenges/:id/runs enqueues,
 * returns a queue item). Model/container come from global defaults at launch. */
const runInput = Type.Object(
  {
    orchestration: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    /** Plugin input snapshot (validated against the plugin's params schema). */
    params: Type.Optional(Type.Unknown()),
    /** Overrides the rendered `initial` template as the run's first prompt. */
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
  },
  { additionalProperties: false }
)

const timeoutInput = Type.Object(
  { timeoutMs: Type.Integer({ minimum: 60_000 }) },
  { additionalProperties: false }
)

const finishInput = Type.Object(
  { summary: Type.Optional(Type.String({ maxLength: 20_000 })) },
  { additionalProperties: false }
)

const switchModelInput = Type.Object(
  {
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false }
)

const flagInput = Type.Object(
  { flag: Type.String({ minLength: 1, maxLength: 10_000 }) },
  { additionalProperties: false }
)

const messageInput = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 20_000 }),
    deliverAs: Type.Optional(
      Type.Union([Type.Literal("steer"), Type.Literal("followUp")])
    ),
  },
  { additionalProperties: false }
)

const queueInput = Type.Object(
  {
    steering: Type.Array(Type.String({ maxLength: 20_000 })),
    followUp: Type.Array(Type.String({ maxLength: 20_000 })),
  },
  { additionalProperties: false }
)

const emptyInput = EmptyInputSchema

export function registerRunRoutes(
  app: Hono,
  options: {
    db: Database
    dataDir: string
    runService: RunService
  }
) {
  const { db, runService } = options

  app.post(
    "/api/challenges/:challengeId/runs",
    validateJson(runInput),
    async (c) => {
      try {
        const input = c.req.valid("json")
        const challengeId = c.req.param("challengeId")
        const challenge = db
          .select()
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .get()
        if (!challenge) return notFound(c, "Challenge not found")

        // Enqueue (spec §10), then run one drain pass so a launchable task is
        // started synchronously; the item stays pending if the fence is full.
        const queue = runService.queue()
        const item = queue.enqueue({
          eventId: challenge.eventId,
          challengeId,
          orchestration: input.orchestration ?? "classic",
          params: input.params as Record<string, unknown> | undefined,
          prompt: input.prompt,
          timeoutMs: input.timeoutMs,
          source: "manual",
        })
        await queue.drainOnce()
        return c.json(
          queue.list(challenge.eventId).find((i) => i.id === item.id) ?? item,
          202
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Orchestration plugin registry (id, scope, params schema, templates) — the
   * create-run dialog renders against it (spec §10). */
  app.get("/api/orchestrations", (c) =>
    c.json({
      items: listPlugins().map((plugin) => ({
        id: plugin.id,
        scope: plugin.scope,
        params: plugin.params,
        templates: plugin.templates ?? {},
      })),
    })
  )

  app.get("/api/runs/:runId", (c) => {
    const detail = runService.detail(c.req.param("runId"))
    if (!detail) return notFound(c, "Run not found")
    return c.json(detail)
  })

  app.get("/api/runs/:runId/files", (c) => {
    const root = runService.runDirPath(c.req.param("runId"))
    if (!root) return notFound(c, "Run not found")
    try {
      return c.json(readWorkspacePath(root, c.req.query("path") ?? ""))
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/runs/:runId/files/download", (c) => {
    const root = runService.runDirPath(c.req.param("runId"))
    if (!root) return notFound(c, "Run not found")
    try {
      const file = workspaceDownload(root, c.req.query("path") ?? "")
      return new Response(file.stream as unknown as ReadableStream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        },
      })
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/runs/:runId/messages", (c) => {
    const runId = c.req.param("runId")
    if (!runService.get(runId)) return notFound(c, "Run not found")
    const afterRaw = Number.parseInt(c.req.query("after") ?? "0", 10)
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    const agentId = c.req.query("agentId") || undefined
    return c.json(runService.listMessages(runId, { after, agentId }))
  })

  // Live event stream (EventSource). Ephemeral progress; reconnect re-reads
  // committed messages via GET .../messages.
  app.get("/api/runs/:runId/stream", (c) =>
    streamRun(c, runService, c.req.param("runId"))
  )

  app.post(
    "/api/runs/:runId/message",
    validateJson(messageInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await runService.sendMessage(c.req.param("runId"), {
          text: body.text,
          deliverAs: body.deliverAs,
        })
        return c.json(run)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.put("/api/runs/:runId/queue", validateJson(queueInput), async (c) => {
    try {
      const body = c.req.valid("json")
      await runService.setQueue(c.req.param("runId"), {
        steering: body.steering,
        followUp: body.followUp,
      })
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/stop", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runService.stop(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post(
    "/api/runs/:runId/timeout",
    validateJson(timeoutInput),
    async (c) => {
      try {
        return c.json(
          runService.setRunTimeout(
            c.req.param("runId"),
            c.req.valid("json").timeoutMs
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/runs/:runId/switch-model",
    validateJson(switchModelInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(
          await runService.switchModel(c.req.param("runId"), {
            modelId: body.modelId,
            ...(body.thinkingLevel !== undefined
              ? { thinkingLevel: body.thinkingLevel }
              : {}),
          })
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/runs/:runId/close", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runService.closeRun(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/finish", validateJson(finishInput), async (c) => {
    try {
      const summary = c.req.valid("json").summary?.trim() ?? ""
      return c.json(await runService.finish(c.req.param("runId"), summary))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/flag", validateJson(flagInput), async (c) => {
    const runId = c.req.param("runId")
    const run = runService.get(runId)
    if (!run) return notFound(c, "Run not found")
    if (!run.challengeId) return notFound(c, "Run has no challenge")
    try {
      const result = await runService.submitFlag(
        runId,
        run.challengeId,
        c.req.valid("json").flag
      )
      runService.refresh(runId)
      if (!result) {
        return badRequest(
          c,
          "not_bound",
          "Challenge is not managed by a platform"
        )
      }
      return c.json({ result })
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  app.get("/api/runs/:runId/target", async (c) => {
    const run = runService.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    if (!run.challengeId) return notFound(c, "Run has no challenge")
    try {
      return c.json(await runService.targetAction(run.challengeId, "get"))
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  for (const action of ["start", "extend", "stop"] as const) {
    app.post(
      `/api/runs/:runId/target/${action}`,
      validateJson(emptyInput),
      async (c) => {
        const run = runService.get(c.req.param("runId"))
        if (!run) return notFound(c, "Run not found")
        if (!run.challengeId) return notFound(c, "Run has no challenge")
        try {
          return c.json(await runService.targetAction(run.challengeId, action))
        } catch (error) {
          return platformActionHttpError(c, error)
        }
      }
    )
  }

  app.delete("/api/runs/:runId", async (c) => {
    try {
      await runService.delete(c.req.param("runId"))
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
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

function workspaceFileError(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceFileError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found" ? 404 : 400
  )
}
