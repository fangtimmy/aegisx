import type { FlatSettings } from "@aegisx/shared"
import { get, normalizeThinkingLevel } from "@aegisx/shared"
import type { LiveEvent } from "@aegisx/shared/live-event"
import { eq } from "drizzle-orm"
import type { Context, Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Type } from "typebox"

import type { createDatabase } from "../db"
import { challenges } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { badRequest, jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { EmptyInputSchema, ThinkingLevelSchema } from "../lib/schemas"
import { platformActionHttpError } from "../platforms/errors"
import { getProviderConnections } from "../providers/public"
import { RunActionError } from "./errors"
import type { RunService } from "./service"

type Database = ReturnType<typeof createDatabase>["db"]

const runInput = Type.Object(
  {
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    image: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 300,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._/:@-]*$",
      })
    ),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  },
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
    getSettings(): FlatSettings
    configStore: ConfigStore
  }
) {
  const { db, runService, getSettings, configStore } = options

  app.post(
    "/api/challenges/:challengeId/runs",
    validateJson(runInput),
    async (c) => {
      try {
        const input = c.req.valid("json")
        const defaults = getSettings()
        const providers = getProviderConnections(configStore)
        const selectedModelId =
          input.modelId ?? get(defaults, "agent.defaultModelId") ?? undefined
        const selected = selectedModelId
          ? (() => {
              for (const provider of providers) {
                const model = provider.models.find(
                  (m) => m.id === selectedModelId
                )
                if (model) return { model, provider }
              }
              return undefined
            })()
          : undefined
        if (!selected?.model.enabled || !selected.provider.enabled) {
          return badRequest(
            c,
            "model_unavailable",
            "Choose an enabled model and provider"
          )
        }
        if (!selected.provider.apiKey) {
          return badRequest(
            c,
            "credentials_unavailable",
            "Enter an API key for the selected provider"
          )
        }

        const challengeId = c.req.param("challengeId")
        const challenge = db
          .select()
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .get()
        if (!challenge) return notFound(c, "Challenge not found")

        const run = await runService.create({
          challengeId,
          provider: selected.provider,
          modelId: selected.model.id,
          thinkingLevel:
            input.thinkingLevel ??
            normalizeThinkingLevel(get(defaults, "agent.defaultThinkingLevel")),
          container: {
            image: input.image?.trim() || get(defaults, "container.image"),
            cpus: get(defaults, "container.cpus"),
            memoryMb: get(defaults, "container.memoryMb"),
            pidsLimit: get(defaults, "container.pidsLimit"),
            tmpfsSize: get(defaults, "container.tmpfsSize"),
            workspace: get(defaults, "container.workspace"),
          },
        })
        return c.json(run, 202)
      } catch (error) {
        return runError(c, error)
      }
    }
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
  app.get("/api/runs/:runId/stream", (c) => {
    const runId = c.req.param("runId")
    const detail = runService.detail(runId)
    if (!detail) return notFound(c, "Run not found")
    const mainAgent = detail.agents.find((a) => a.isEntry)
    const bus = runService.bus

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
      // Wake a pending idle wait on abort too — otherwise the await never
      // resolves, the loop never exits, and the subscription leaks.
      stream.onAbort(() => {
        aborted = true
        drain()
      })
      const unsubscribe = bus.subscribe(runId, (event) => {
        queue.push(event)
        drain()
      })

      // Initial snapshot so a fresh connection sees current state immediately.
      queue.push({ type: "ready", runId, agentId: mainAgent?.id ?? "" })
      queue.push({ type: "run.updated", run: detail.run })
      for (const agent of detail.agents) {
        queue.push({ type: "agent.updated", agent })
        const context = bus.getContext(agent.id)
        if (context) queue.push(context)
        const queueState = bus.getQueue(agent.id)
        if (queueState) queue.push(queueState)
        const activity = bus.getActivity(agent.id)
        if (activity) queue.push(activity)
        // Replay in-flight tools (with their latest partial result) so a fresh
        // connection sees an executing bash command's streamed output right
        // away, not only events that arrive after connect.
        for (const tool of bus.getToolProgress(agent.id)) queue.push(tool)
      }

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
