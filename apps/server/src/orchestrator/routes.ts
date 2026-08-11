import type { LiveEvent } from "@aegisx/shared/live-event"
import type { Context, Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Type } from "typebox"

import { jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  workspaceDownload,
  WorkspaceFileError,
} from "../infrastructure/workspace-files"
import { ThinkingLevelSchema } from "../lib/schemas"
import { OrchestratorActionError, type OrchestratorService } from "./service"

function workspaceFileError(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceFileError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found" ? 404 : 400
  )
}

const configInput = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    modelId: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])
    ),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    instruction: Type.Optional(Type.String({ maxLength: 20_000 })),
    maxConcurrentTargets: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 32 })
    ),
  },
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

const emptyInput = Type.Object({}, { additionalProperties: false })

const switchModelInput = Type.Object(
  {
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false }
)

export function registerOrchestratorRoutes(
  app: Hono,
  options: { orchestratorService: OrchestratorService }
) {
  const { orchestratorService } = options

  app.get("/api/events/:eventId/orchestrator", (c) => {
    const detail = orchestratorService.getDetail(c.req.param("eventId"))
    if (!detail) return notFound(c, "Event not found")
    return c.json(detail)
  })

  app.patch(
    "/api/events/:eventId/orchestrator",
    validateJson(configInput),
    (c) => {
      const detail = orchestratorService.patchConfig(
        c.req.param("eventId"),
        c.req.valid("json")
      )
      if (!detail) return notFound(c, "Event not found")
      return c.json(detail)
    }
  )

  app.get("/api/events/:eventId/orchestrator/messages", (c) => {
    const eventId = c.req.param("eventId")
    const afterRaw = Number.parseInt(c.req.query("after") ?? "0", 10)
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    return c.json(orchestratorService.listMessages(eventId, { after }))
  })

  // Workspace file browser (same shape as run files). The orchestrator's
  // per-event workspace lives under its data dir; before first start the dir
  // may not exist yet — surface an empty directory rather than an error.
  app.get("/api/events/:eventId/orchestrator/files", (c) => {
    const root = orchestratorService.dirPath(c.req.param("eventId"))
    if (!root) return notFound(c, "Event not found")
    try {
      return c.json(readWorkspacePath(root, c.req.query("path") ?? ""))
    } catch (error) {
      // Before the orchestrator's first start the workspace dir doesn't exist
      // yet — surface an empty directory instead of a 404 so the Files tab
      // renders a clean empty state.
      if (error instanceof WorkspaceFileError && error.code === "not_found") {
        return c.json({
          path: c.req.query("path") ?? "",
          type: "directory",
          entries: [],
        })
      }
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/events/:eventId/orchestrator/files/download", (c) => {
    const root = orchestratorService.dirPath(c.req.param("eventId"))
    if (!root) return notFound(c, "Event not found")
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

  // Live event stream (EventSource). Same shape as the run stream: ephemeral
  // pipeline events (message/tool progress); reconnect re-reads committed
  // entries via GET .../messages.
  app.get("/api/events/:eventId/orchestrator/stream", (c) => {
    const eventId = c.req.param("eventId")
    const detail = orchestratorService.getDetail(eventId)
    if (!detail) return notFound(c, "Event not found")
    const bus = orchestratorService.bus
    return streamSSE(c, async (stream) => {
      let aborted = false
      const queue: LiveEvent[] = []
      let resolveNext: (() => void) | null = null
      const drain = () => {
        if (resolveNext) {
          const fn = resolveNext
          resolveNext = null
          fn()
        }
      }
      stream.onAbort(() => {
        aborted = true
        drain()
      })
      const unsubscribe = bus.subscribe(eventId, (event) => {
        queue.push(event)
        drain()
      })
      queue.push({
        type: "ready",
        runId: eventId,
        agentId: orchestratorService.agentId,
      })
      // Seed the live ephemeral snapshot (context + current activity +
      // in-flight tools with their latest partial result) so the composer stat
      // strip AND an executing bash command's streamed output show immediately
      // on (re)connect, mirroring the run stream.
      const context = bus.getContext(orchestratorService.agentId)
      if (context) queue.push(context)
      const activity = bus.getActivity(orchestratorService.agentId)
      if (activity) queue.push(activity)
      for (const tool of bus.getToolProgress(orchestratorService.agentId))
        queue.push(tool)
      try {
        while (!aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              resolveNext = resolve
            })
            if (aborted) break
          }
          while (queue.length > 0) {
            const event = queue.shift() as LiveEvent
            await stream.writeSSE({ data: JSON.stringify(event) })
          }
        }
      } catch {
        // client gone
      } finally {
        unsubscribe()
      }
    })
  })

  app.post(
    "/api/events/:eventId/orchestrator/message",
    validateJson(messageInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(
          await orchestratorService.sendMessage(c.req.param("eventId"), {
            text: body.text,
            deliverAs: body.deliverAs,
          })
        )
      } catch (error) {
        return orchError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/orchestrator/start",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(await orchestratorService.start(c.req.param("eventId")))
      } catch (error) {
        return orchError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/orchestrator/new-session",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(
          await orchestratorService.newSession(c.req.param("eventId"))
        )
      } catch (error) {
        return orchError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/orchestrator/stop",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(await orchestratorService.stop(c.req.param("eventId")))
      } catch (error) {
        return orchError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/orchestrator/switch-model",
    validateJson(switchModelInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(
          await orchestratorService.switchModel(c.req.param("eventId"), {
            modelId: body.modelId,
            ...(body.thinkingLevel !== undefined
              ? { thinkingLevel: body.thinkingLevel }
              : {}),
          })
        )
      } catch (error) {
        return orchError(c, error)
      }
    }
  )

  app.post(
    "/api/events/:eventId/orchestrator/close",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(
          await orchestratorService.closeOrchestrator(c.req.param("eventId"))
        )
      } catch (error) {
        return orchError(c, error)
      }
    }
  )
}

function orchError(c: Context, error: unknown) {
  if (!(error instanceof OrchestratorActionError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found"
      ? 404
      : error.code === "launch_failed"
        ? 500
        : 409
  )
}
