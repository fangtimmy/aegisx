import { mkdirSync } from "node:fs"
import { join, relative } from "node:path"
import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Type } from "typebox"
import { normalizeThinkingLevel } from "../../../shared"
import type { createDatabase } from "../db"
import { challenges } from "../db/schema"
import type { createCatalogReader } from "../events/catalog"
import type { ConfigStore } from "../infrastructure/config-store"
import { jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { getChallengeRemote } from "../platforms/challenge-state"
import { parseModelMetadata } from "../providers/models"
import { providerName } from "../providers/routes"
import {
  renderInitialPrompt,
  resolvePromptTemplates,
} from "../settings/prompt-templates"
import { RunActionError } from "./errors"
import type { createLiveRunService } from "./live"
import { createPromptContextBuilder } from "./prompt"
import { eventStatistics } from "./stats"

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
type RunService = ReturnType<typeof createLiveRunService>
type Catalog = ReturnType<typeof createCatalogReader>
type SettingsPublic = ReturnType<ConfigStore["getSettings"]>

export function registerRunRoutes(
  app: Hono,
  options: {
    db: Database
    dataDir: string
    runService: RunService
    getSettings(): SettingsPublic
    configStore: ConfigStore
    catalog: Pick<Catalog, "getChallenge" | "getEvent">
  }
) {
  const { db, dataDir, runService, getSettings, configStore, catalog } = options
  const { getChallenge, getEvent } = catalog
  const prompts = createPromptContextBuilder({
    db,
    dataDir,
    getContainerWorkspace: () => getSettings().containerWorkspace,
  })

  app.post(
    "/api/challenges/:challengeId/runs",
    validateJson(runInput),
    async (c) => {
      const input = c.req.valid("json")
      try {
        const defaults = getSettings()
        const selectedModelId = input.modelId ?? defaults.defaultModelId
        const selected = selectedModelId
          ? (() => {
              for (const provider of configStore.getProviders()) {
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

        const environmentType = input.environment ?? defaults.environment
        const environment =
          environmentType === "container"
            ? {
                type: "container" as const,
                image: input.image?.trim() || defaults.containerImage,
                cpus: defaults.cpus,
                memoryMb: defaults.memoryMb,
                pidsLimit: defaults.pidsLimit,
              }
            : ({ type: "local" } as const)

        const model = {
          provider: providerName(selected.provider.id),
          providerLabel: selected.provider.label,
          modelId: selected.model.modelId,
          modelLabel: selected.model.label,
          costKnown: parseModelMetadata(selected.model.metadata).costKnown,
          thinkingLevel:
            input.thinkingLevel ??
            normalizeThinkingLevel(defaults.defaultThinkingLevel),
        }

        const runId = crypto.randomUUID()
        const mainAgentId = crypto.randomUUID()
        const workspaceAbs = join(dataDir, "workspaces", runId)
        mkdirSync(workspaceAbs, { recursive: true })
        const remote = getChallengeRemote(db, challengeId)
        const challengeAttachments = prompts.copyAttachments(
          challengeId,
          workspaceAbs
        )
        const promptTemplates = resolvePromptTemplates(getSettings())
        const promptContext = prompts.buildPromptContext(
          runId,
          challenge,
          remote,
          challengeAttachments,
          environment,
          model,
          { name: "Main agent", task: null, isMain: true }
        )
        const bootstrapText = renderInitialPrompt(
          promptTemplates.initialPromptTemplate,
          promptContext
        )

        const run = await runService.create({
          runId,
          mainAgentId,
          challengeId,
          model,
          env: environment,
          prompt: { ...promptTemplates, context: promptContext },
          workspacePath: relative(dataDir, workspaceAbs),
          bootstrapText,
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
    const agents = runService.agents(run.id)
    return c.json({
      run,
      agents,
      usage: runService.usage(run.id),
    })
  })

  app.get("/api/runs/:runId/messages", (c) => {
    const run = runService.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    const agentId = c.req.query("agentId")
    const after = Number(c.req.query("after") ?? 0)
    const afterSeq = Number.isSafeInteger(after) && after >= 0 ? after : 0
    if (agentId) {
      const agent = runService.getAgent(run.id, agentId)
      if (!agent) return notFound(c, "Agent not found")
      return c.json({
        runId: run.id,
        agentId,
        messages: runService.store.listMessages(agentId, afterSeq),
      })
    }
    return c.json({
      runId: run.id,
      messages: runService.store.listRunMessages(run.id, afterSeq),
    })
  })

  app.get("/api/runs/:runId/agents/:agentId", (c) => {
    const run = runService.get(c.req.param("runId"))
    const agent = runService.getAgent(
      c.req.param("runId"),
      c.req.param("agentId")
    )
    if (!run || !agent) return notFound(c, "Agent not found")
    return c.json({
      agent,
      messages: runService.store.listMessages(agent.id),
      stats: runService.agentUsage(agent.id),
    })
  })

  app.get("/api/runs/:runId/agents/:agentId/inspector", (c) => {
    const value = runService.inspector(
      c.req.param("runId"),
      c.req.param("agentId")
    )
    if (!value) return notFound(c, "Agent not found")
    return c.json(value)
  })

  app.get("/api/runs/:runId/stats", (c) => {
    const run = runService.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    return c.json({ runId: run.id, usage: runService.usage(run.id) })
  })

  app.get("/api/challenges/:challengeId/stats", (c) => {
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) return notFound(c, "Challenge not found")
    const items = runService.listForChallenge(challenge.id).map((run) => ({
      run,
      usage: runService.usage(run.id),
    }))
    return c.json({
      challengeId: challenge.id,
      runCount: items.length,
      usage: items.reduce(
        (acc, item) => ({
          input: acc.input + item.usage.input,
          output: acc.output + item.usage.output,
          cacheRead: acc.cacheRead + item.usage.cacheRead,
          cacheWrite: acc.cacheWrite + item.usage.cacheWrite,
          totalTokens: acc.totalTokens + item.usage.totalTokens,
          cost:
            acc.cost === null || item.usage.cost === null
              ? null
              : (acc.cost ?? 0) + item.usage.cost,
        }),
        {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0 as number | null,
        }
      ),
      runs: items,
    })
  })

  app.get("/api/events/:eventId/stats", (c) => {
    const event = getEvent(c.req.param("eventId"))
    if (!event) return notFound(c, "Event not found")
    const eventRuns = runService.listForEvent(event.id)
    const usageByRun = new Map(
      eventRuns.map((run) => [run.id, runService.usage(run.id)])
    )
    return c.json(eventStatistics(db, event.id, eventRuns, usageByRun))
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

  app.get("/api/runs/:runId/stream", (c) => {
    const runId = c.req.param("runId")
    const run = runService.get(runId)
    if (!run) return notFound(c, "Run not found")
    return streamSSE(c, async (stream) => {
      let finished = false
      let unsubscribe = () => {}
      let heartbeat: ReturnType<typeof setInterval> | undefined
      // Serialize all SSE writes (snapshot + live) so events cannot reorder.
      let writeChain: Promise<void> = Promise.resolve()
      const finish = () => {
        if (finished) return
        finished = true
        if (heartbeat !== undefined) clearInterval(heartbeat)
        unsubscribe()
      }
      const enqueue = (write: () => Promise<void>) => {
        if (finished) return writeChain
        writeChain = writeChain
          .then(async () => {
            if (finished) return
            await write()
          })
          .catch(() => {
            finish()
          })
        return writeChain
      }
      const sendData = (data: string) =>
        enqueue(() => stream.writeSSE({ data }))
      // SSE comment frames are ignored by EventSource and keep proxies awake.
      const sendPing = () =>
        enqueue(async () => {
          await stream.write(":ping\n\n")
        })
      // Subscribe before snapshot so live events that arrive mid-snapshot stay ordered.
      unsubscribe = runService.subscribe(runId, (event) => {
        void sendData(JSON.stringify(event))
      })
      c.req.raw.signal.addEventListener("abort", finish, { once: true })
      try {
        await sendData(JSON.stringify({ type: "ready", runId }))
        await sendData(
          JSON.stringify({
            type: "run.updated",
            run: runService.get(runId),
          })
        )
        for (const agent of runService.agents(runId)) {
          await sendData(JSON.stringify({ type: "agent.updated", agent }))
        }
        if (finished) return
        // Keep proxies awake; Bun idleTimeout is disabled in index.ts.
        heartbeat = setInterval(() => {
          void sendPing()
        }, 15_000)
        await new Promise<void>((resolve) => {
          if (c.req.raw.signal.aborted) {
            resolve()
            return
          }
          c.req.raw.signal.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
        await writeChain
      } catch {
        finish()
      } finally {
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
          await runService.postMessage(
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

  app.post(
    "/api/runs/:runId/messages",
    validateJson(messageInput),
    async (c) => {
      try {
        return c.json(
          await runService.postMessage(
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
      return c.json(await runService.pause(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/resume", validateJson(resumeInput), async (c) => {
    try {
      return c.json(
        await runService.resume(
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
      return c.json(await runService.stop(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

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
