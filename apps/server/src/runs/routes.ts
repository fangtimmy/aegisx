import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Type } from "typebox"
import { sumUsage } from "../agents/usage"
import type { createCatalogReader } from "../catalog"
import type { createDatabase } from "../db"
import {
  challenges,
  providerConnections,
  providerModels,
  type settings,
} from "../db/schema"
import { jsonError, notFound } from "../http-errors"
import { parseModelMetadata } from "../models"
import { providerName } from "../provider-routes"
import { validateJson } from "../validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../workspace-files"
import { type createRunManager, RunActionError } from "./manager"

const runInput = Type.Object(
  {
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    environment: Type.Optional(
      Type.Union([Type.Literal("local"), Type.Literal("container")])
    ),
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

const messageInput = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 100_000 }),
    clientMessageId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100 })
    ),
  },
  { additionalProperties: false }
)

const resumeInput = Type.Object(
  {
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
    clientMessageId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100 })
    ),
  },
  { additionalProperties: false }
)

const emptyInput = Type.Object({}, { additionalProperties: false })

type Database = ReturnType<typeof createDatabase>["db"]
type RunManager = ReturnType<typeof createRunManager>
type Catalog = ReturnType<typeof createCatalogReader>

export function registerRunRoutes(
  app: Hono,
  options: {
    db: Database
    runManager: RunManager
    getSettings(): typeof settings.$inferSelect
    catalog: Pick<Catalog, "getChallenge" | "getEvent">
  }
) {
  const { db, runManager, getSettings, catalog } = options
  const { getChallenge, getEvent } = catalog

  app.post(
    "/api/challenges/:challengeId/runs",
    validateJson(runInput),
    async (c) => {
      const input = c.req.valid("json")
      try {
        const defaults = getSettings()
        const selectedModelId = input.modelId ?? defaults.defaultModelId
        const selected = selectedModelId
          ? db
              .select({ model: providerModels, provider: providerConnections })
              .from(providerModels)
              .innerJoin(
                providerConnections,
                eq(providerModels.providerId, providerConnections.id)
              )
              .where(eq(providerModels.id, selectedModelId))
              .get()
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
        const environmentType = input.environment ?? defaults.environment
        const environment =
          environmentType === "container"
            ? {
                type: "container" as const,
                image: input.image?.trim() || defaults.containerImage,
                cpus: defaults.cpuLimit / 1000,
                memoryMb: defaults.memoryMb,
                pidsLimit: defaults.pidsLimit,
              }
            : ({ type: "local" } as const)
        return c.json(
          await runManager.create(
            c.req.param("challengeId"),
            {
              provider: providerName(selected.provider.id),
              providerLabel: selected.provider.label,
              modelId: selected.model.modelId,
              modelLabel: selected.model.label,
              costKnown: parseModelMetadata(selected.model.metadata).costKnown,
              thinkingLevel: input.thinkingLevel ?? "off",
            },
            environment
          ),
          202
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.get("/api/runs/:runId", (c) => {
    const run = runManager.get(c.req.param("runId"), true)
    if (!run) return notFound(c, "Run not found")
    const agents = runManager.agents(run.id)
    const main = agents.find((agent) => agent.parentAgentId === null)
    const snapshot = main
      ? runManager.conversationSnapshot(main.id)
      : { messages: [], cursor: runManager.cursor(run.id) }
    return c.json({
      run,
      agents,
      messages: snapshot.messages,
      stats: sumUsage(agents.map((agent) => agent.usage)),
      cursor: snapshot.cursor,
    })
  })

  app.get("/api/runs/:runId/conversation", (c) => {
    const run = runManager.get(c.req.param("runId"))
    const agentId = c.req.query("agentId")
    const agent = agentId ? runManager.agent(agentId) : undefined
    if (!run || !agent || agent.runId !== run.id)
      return notFound(c, "Agent not found")
    const snapshot = runManager.conversationSnapshot(agent.id)
    return c.json({
      runId: run.id,
      agentId: agent.id,
      messages: snapshot.messages,
      cursor: snapshot.cursor,
    })
  })

  app.get("/api/runs/:runId/agents/:agentId", (c) => {
    const run = runManager.get(c.req.param("runId"))
    const agent = runManager.agent(c.req.param("agentId"))
    if (!run || !agent || agent.runId !== run.id)
      return notFound(c, "Agent not found")
    const snapshot = runManager.conversationSnapshot(agent.id)
    return c.json({
      agent,
      messages: snapshot.messages,
      cursor: snapshot.cursor,
      stats: runManager.agentUsage(agent.id),
    })
  })

  app.get("/api/runs/:runId/agents/:agentId/inspector", (c) => {
    const run = runManager.get(c.req.param("runId"))
    const agent = runManager.agent(c.req.param("agentId"))
    if (!run || !agent || agent.runId !== run.id)
      return notFound(c, "Agent not found")
    return c.json(runManager.inspector(agent.id))
  })

  app.get("/api/runs/:runId/stats", (c) => {
    const run = runManager.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    return c.json({ runId: run.id, usage: runManager.usage(run.id) })
  })

  app.get("/api/challenges/:challengeId/stats", (c) => {
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) return notFound(c, "Challenge not found")
    const items = runManager.listForChallenge(challenge.id).map((run) => ({
      run,
      usage: runManager.usage(run.id),
    }))
    return c.json({
      challengeId: challenge.id,
      runCount: items.length,
      usage: sumUsage(items.map((item) => item.usage)),
      runs: items,
    })
  })

  app.get("/api/events/:eventId/stats", (c) => {
    const event = getEvent(c.req.param("eventId"))
    if (!event) return notFound(c, "Event not found")
    const items = runManager.listForEvent(event.id).map((run) => ({
      run,
      usage: runManager.usage(run.id),
    }))
    const challengesByEvent = db
      .select()
      .from(challenges)
      .where(eq(challenges.eventId, event.id))
      .all()
      .map((challenge) => {
        const challengeRuns = items.filter(
          ({ run }) => run.challengeId === challenge.id
        )
        return {
          challengeId: challenge.id,
          challengeName: challenge.name,
          runCount: challengeRuns.length,
          usage: sumUsage(challengeRuns.map((item) => item.usage)),
        }
      })
    return c.json({
      eventId: event.id,
      runCount: items.length,
      usage: sumUsage(items.map((item) => item.usage)),
      challenges: challengesByEvent,
      runs: items,
    })
  })

  app.get("/api/runs/:runId/files", (c) => {
    const workspacePath = runManager.workspacePath(c.req.param("runId"))
    if (!workspacePath) return notFound(c, "Run not found")
    try {
      return c.json(readWorkspacePath(workspacePath, c.req.query("path") ?? ""))
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/runs/:runId/files/download", (c) => {
    const workspacePath = runManager.workspacePath(c.req.param("runId"))
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

  app.get("/api/runs/:runId/events", (c) => {
    const runId = c.req.param("runId")
    const run = runManager.get(runId)
    if (!run) return notFound(c, "Run not found")
    const parsedLastEventId = Number(
      c.req.header("last-event-id") ?? c.req.query("after")
    )
    const lastEventId =
      Number.isSafeInteger(parsedLastEventId) && parsedLastEventId >= 0
        ? parsedLastEventId
        : 0
    return streamSSE(c, async (stream) => {
      const maxPendingEvents = 512
      const pending: Array<{ sequence: number; event: unknown }> = []
      const replayed: Array<{ sequence: number; event: unknown }> = []
      let ready = false
      let finished = false
      let deliveredCursor = lastEventId
      let unsubscribe = () => {}
      let finish = () => {}
      let writing = false
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
      const coalesceKey = (value: { event: unknown }) => {
        if (!isRecord(value.event)) return null
        if (value.event.type === "message.progress") {
          return `message:${String(value.event.agentId ?? "")}:${String(value.event.messageId ?? "")}`
        }
        if (value.event.type === "tool.progress") {
          return `tool:${String(value.event.agentId ?? "")}:${String(value.event.toolCallId ?? "")}`
        }
        return null
      }
      const writePending = async () => {
        if (writing || finished) return
        writing = true
        try {
          while (!finished && pending.length > 0) {
            const item = pending.shift()
            if (!item) continue
            if (item.sequence > 0 && item.sequence <= deliveredCursor) continue
            await stream.writeSSE({
              ...(item.sequence > 0 ? { id: String(item.sequence) } : {}),
              data: JSON.stringify(item.event),
            })
            if (item.sequence > 0) deliveredCursor = item.sequence
          }
        } catch {
          finish()
        } finally {
          writing = false
        }
      }
      const queuePending = (event: { sequence: number; event: unknown }) => {
        if (finished) return false
        const key = coalesceKey(event)
        if (key) {
          const index = pending.findLastIndex(
            (value) => coalesceKey(value) === key
          )
          if (index !== -1) {
            pending[index] = event
            return true
          }
        }
        if (pending.length >= maxPendingEvents) {
          finish()
          return false
        }
        pending.push(event)
        return true
      }
      const enqueue = (event: { sequence: number; event: unknown }) => {
        if (finished || !queuePending(event)) return
        void writePending()
      }
      const done = new Promise<void>((resolve) => {
        finish = () => {
          if (finished) return
          finished = true
          pending.length = 0
          unsubscribe()
          resolve()
        }
      })
      unsubscribe = runManager.subscribe(
        runId,
        (event, sequence, replay) => {
          const item = { sequence, event }
          if (!ready) {
            if (replay) replayed.push(item)
            else queuePending(item)
          } else enqueue(item)
        },
        lastEventId
      )
      c.req.raw.signal.addEventListener("abort", finish, { once: true })
      try {
        for (const item of replayed) {
          if (item.sequence > 0 && item.sequence <= deliveredCursor) continue
          await stream.writeSSE({
            ...(item.sequence > 0 ? { id: String(item.sequence) } : {}),
            data: JSON.stringify(item.event),
          })
          if (item.sequence > 0) deliveredCursor = item.sequence
        }
        await stream.writeSSE({
          data: JSON.stringify({
            type: "ready",
            runId,
            cursor: runManager.cursor(runId),
          }),
        })
        await stream.writeSSE({
          data: JSON.stringify({
            type: "run.updated",
            run: runManager.get(runId),
          }),
        })
        for (const agent of runManager.agents(runId)) {
          await stream.writeSSE({
            data: JSON.stringify({ type: "agent.updated", agent }),
          })
        }
        while (pending.length > 0) {
          const item = pending.shift()
          if (!item) continue
          if (item.sequence > 0 && item.sequence <= deliveredCursor) continue
          await stream.writeSSE({
            ...(item.sequence > 0 ? { id: String(item.sequence) } : {}),
            data: JSON.stringify(item.event),
          })
          if (item.sequence > 0) deliveredCursor = item.sequence
        }
        ready = true
        await done
      } catch {
        finish()
      }
    })
  })

  app.post(
    "/api/runs/:runId/message",
    validateJson(messageInput),
    async (c) => {
      try {
        return c.json(
          await runManager.message(
            c.req.param("runId"),
            c.req.valid("json").message.trim(),
            c.req.valid("json").clientMessageId
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/runs/:runId/pause", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runManager.pause(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/resume", validateJson(resumeInput), async (c) => {
    try {
      return c.json(
        await runManager.resume(
          c.req.param("runId"),
          c.req.valid("json").message,
          c.req.valid("json").clientMessageId
        )
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/stop", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runManager.stop(c.req.param("runId")))
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
    error.code === "not_found" ? 404 : 409
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
