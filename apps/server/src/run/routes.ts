import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { Type } from "typebox"
import type { FlatSettings } from "../../../shared"
import { get, normalizeThinkingLevel } from "../../../shared"
import type { createDatabase } from "../db"
import { challenges } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { PlatformActionError } from "../platforms/service"
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
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ])
    ),
  },
  { additionalProperties: false }
)

const finishInput = Type.Object(
  { summary: Type.Optional(Type.String({ maxLength: 20_000 })) },
  { additionalProperties: false }
)

const flagInput = Type.Object(
  { flag: Type.String({ minLength: 1, maxLength: 10_000 }) },
  { additionalProperties: false }
)

const emptyInput = Type.Object({}, { additionalProperties: false })

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
  const port = process.env.PORT ?? "3000"
  const apiUrl = `http://host.docker.internal:${port}`

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
          return c.json(
            {
              error: {
                code: "model_unavailable",
                message: "Choose an enabled model and provider",
              },
            },
            400
          )
        }
        if (!selected.provider.apiKey) {
          return c.json(
            {
              error: {
                code: "credentials_unavailable",
                message: "Enter an API key for the selected provider",
              },
            },
            400
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
            apiUrl,
          },
        })
        return c.json(run, 202)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.get("/api/runs/:runId", (c) => {
    const run = runService.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    return c.json({ run })
  })

  app.get("/api/runs/:runId/files", (c) => {
    const workspacePath = runService.workspacePath(c.req.param("runId"))
    if (!workspacePath) return notFound(c, "Run not found")
    try {
      return c.json(readWorkspacePath(workspacePath, c.req.query("path") ?? ""))
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/runs/:runId/files/download", (c) => {
    const workspacePath = runService.workspacePath(c.req.param("runId"))
    if (!workspacePath) return notFound(c, "Run not found")
    try {
      const file = workspaceDownload(workspacePath, c.req.query("path") ?? "")
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

  // PTY bridge: binary frames = stdin/stdout bytes; text frame = JSON control
  // ({type:'resize',cols,rows} | {type:'ping'}).
  app.get(
    "/api/runs/:runId/pty",
    upgradeWebSocket((c) => {
      const runId = c.req.param("runId") ?? ""
      return {
        onOpen: (_evt, ws) => {
          const bridge = runService.ptyBridge(runId)
          if (!bridge) {
            ws.close(1008, "Run is not running")
            return
          }
          bridge.addConnection(ws)
        },
        onMessage: (evt, ws) => {
          const bridge = runService.ptyBridge(runId)
          if (!bridge) return
          const data = evt.data
          if (typeof data === "string") {
            bridge.onMessage(ws, data)
          } else if (data instanceof ArrayBuffer) {
            bridge.onMessage(ws, data)
          }
        },
        onClose: (_evt, ws) => {
          runService.ptyBridge(runId)?.removeConnection(ws)
        },
      }
    })
  )

  app.post("/api/runs/:runId/stop", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runService.stop(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/resume", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runService.resume(c.req.param("runId")))
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
    try {
      const result = await runService.submitFlag(
        runId,
        run.challengeId,
        c.req.valid("json").flag
      )
      // Refresh so the accepted flag is reflected on the run row.
      runService.refresh(runId)
      if (!result) {
        return c.json(
          {
            error: {
              code: "not_bound",
              message: "Challenge is not managed by a platform",
            },
          },
          400
        )
      }
      return c.json({ result })
    } catch (error) {
      return platformError(c, error)
    }
  })

  app.get("/api/runs/:runId/target", async (c) => {
    const run = runService.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    try {
      return c.json(await runService.targetAction(run.challengeId, "get"))
    } catch (error) {
      return platformError(c, error)
    }
  })

  for (const action of ["start", "extend", "stop"] as const) {
    app.post(
      `/api/runs/:runId/target/${action}`,
      validateJson(emptyInput),
      async (c) => {
        const run = runService.get(c.req.param("runId"))
        if (!run) return notFound(c, "Run not found")
        try {
          return c.json(await runService.targetAction(run.challengeId, action))
        } catch (error) {
          return platformError(c, error)
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

function runError(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  error: unknown
) {
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

function workspaceFileError(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  error: unknown
) {
  if (!(error instanceof WorkspaceFileError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found" ? 404 : 400
  )
}

function platformError(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  error: unknown
) {
  if (!(error instanceof PlatformActionError)) throw error
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "invalid_state"
        ? 409
        : error.code === "not_bound"
          ? 400
          : 502
  return jsonError(c, { code: error.code, message: error.message }, status)
}
