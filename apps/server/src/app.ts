import { existsSync } from "node:fs"
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai"
import { and, count, eq, getTableColumns, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Type } from "typebox"
import { createDatabase } from "./db"
import {
  attachments,
  challenges,
  events,
  providerConnections,
  providerModels,
  runs,
  settings,
} from "./db/schema"
import { createModelService } from "./models"
import { providerName, registerProviderRoutes } from "./provider-routes"
import { redactSecrets } from "./redaction"
import { createRunManager, RunActionError } from "./runs"
import { createStorage, isSafeFilename } from "./storage"
import { sumUsage } from "./usage"
import { validateJson } from "./validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "./workspace-files"

const eventInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 160 }),
  },
  { additionalProperties: false }
)

const challengeInput = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.String({ minLength: 1, maxLength: 100_000 }),
  category: Type.Optional(
    Type.Union([Type.String({ maxLength: 80 }), Type.Null()])
  ),
  points: Type.Optional(
    Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])
  ),
})

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
  },
  { additionalProperties: false }
)

const messageInput = Type.Object(
  { message: Type.String({ minLength: 1, maxLength: 100_000 }) },
  { additionalProperties: false }
)

const resumeInput = Type.Object(
  { message: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })) },
  { additionalProperties: false }
)

const emptyInput = Type.Object({}, { additionalProperties: false })

function cleanText(value: string | null | undefined) {
  const cleaned = value?.trim()
  return cleaned ? cleaned : null
}

export function createApp(options: {
  dataDir: string
  maxConcurrency?: number
  models?: MutableModels
  resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined
}) {
  const { db, sqlite } = createDatabase(options.dataDir)
  const storage = createStorage(options.dataDir)
  const modelService = createModelService(
    db,
    options.models,
    options.resolveModel
  )
  const providerSecrets = new Map<string, Set<string>>()
  const listProviderModels = (providerId: string) =>
    db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, providerId))
      .all()
  const syncModels = () => {
    const activeProviders = db
      .select()
      .from(providerConnections)
      .all()
      .map((provider) => ({
        provider,
        models: listProviderModels(provider.id).filter(
          (model) => model.enabled
        ),
      }))
      .filter(
        ({ provider, models }) =>
          provider.enabled && Boolean(provider.apiKey) && models.length > 0
      )
    for (const { provider } of activeProviders) {
      const name = providerName(provider.id)
      const secrets = providerSecrets.get(name) ?? new Set<string>()
      secrets.add(provider.apiKey)
      providerSecrets.set(name, secrets)
    }
    modelService.sync()
  }
  if (!db.select().from(settings).where(eq(settings.id, 1)).get()) {
    const now = new Date().toISOString()
    db.insert(providerConnections)
      .values({
        id: "default-provider",
        label: "Anthropic",
        type: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "",
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(providerModels)
      .values({
        id: "default-model",
        providerId: "default-provider",
        modelId: "claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(settings)
      .values({ id: 1, defaultModelId: "default-model", updatedAt: now })
      .run()
  }
  const getSettings = () => {
    const value = db.select().from(settings).where(eq(settings.id, 1)).get()
    if (!value) throw new Error("Settings are unavailable")
    return value
  }
  syncModels()
  const initialSettings = getSettings()
  const environmentConcurrency = process.env.AEGISX_MAX_CONCURRENCY
    ? Number(process.env.AEGISX_MAX_CONCURRENCY)
    : undefined
  const configuredConcurrency =
    options.maxConcurrency ??
    environmentConcurrency ??
    initialSettings.maxConcurrency
  const runManager = createRunManager({
    db,
    dataDir: options.dataDir,
    maxConcurrency:
      Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency
        : 2,
    getApiKeys: (provider) => providerSecrets.get(provider) ?? [],
    modelService,
  })
  const app = new Hono()

  const listEvents = () =>
    db
      .select({
        ...getTableColumns(events),
        challengeCount: count(challenges.id),
      })
      .from(events)
      .leftJoin(challenges, eq(challenges.eventId, events.id))
      .groupBy(events.id)
      .orderBy(events.createdAt)
      .all()

  const getEvent = (eventId: string) =>
    listEvents().find((event) => event.id === eventId)

  const getChallenge = (challengeId: string) => {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) return undefined
    const challengeAttachments = db
      .select({
        id: attachments.id,
        challengeId: attachments.challengeId,
        originalName: attachments.originalName,
        size: attachments.size,
        sha256: attachments.sha256,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(eq(attachments.challengeId, challengeId))
      .all()
      .map((attachment) => ({
        ...attachment,
        downloadUrl: `/api/attachments/${attachment.id}`,
      }))
    const runCount = db
      .select({ value: count() })
      .from(runs)
      .where(eq(runs.challengeId, challengeId))
      .get()?.value
    return {
      ...challenge,
      attachments: challengeAttachments,
      runCount: Number(runCount ?? 0),
      status: "not_started" as const,
    }
  }

  app.onError((error, c) => {
    const secrets = [...providerSecrets.values()].flatMap((values) => [
      ...values,
    ])
    console.error("Request failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
        secrets
      ),
    })
    return c.json(
      { error: { code: "internal_error", message: "Request failed" } },
      500
    )
  })

  app.get("/", (c) => c.json({ name: "AegisX", status: "ok" }))

  registerProviderRoutes(app, {
    db,
    getSettings,
    listProviderModels,
    syncModels,
    setMaxConcurrency: runManager.setMaxConcurrency,
  })

  app.get("/api/platform/status", (c) => c.json({ available: false }))

  app.get("/api/events", (c) => c.json({ items: listEvents() }))

  app.post("/api/events", validateJson(eventInput), (c) => {
    const input = c.req.valid("json")
    const now = new Date().toISOString()
    const event = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      createdAt: now,
      updatedAt: now,
    }
    if (!event.name) {
      return c.json(
        { error: { code: "invalid_name", message: "Event name is required" } },
        400
      )
    }
    db.insert(events).values(event).run()
    return c.json({ ...event, challengeCount: 0 }, 201)
  })

  app.get("/api/events/:eventId", (c) => {
    const event = getEvent(c.req.param("eventId"))
    if (!event) {
      return c.json(
        { error: { code: "not_found", message: "Event not found" } },
        404
      )
    }
    const eventChallenges = db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, event.id))
      .all()
      .map(({ id }) => getChallenge(id))
      .filter((challenge) => challenge !== undefined)
    return c.json({ event, challenges: eventChallenges })
  })

  app.get("/api/events/:eventId/runs", (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return c.json(
        { error: { code: "not_found", message: "Event not found" } },
        404
      )
    }
    return c.json({ items: runManager.listForEvent(eventId) })
  })

  app.patch("/api/events/:eventId", validateJson(eventInput), (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return c.json(
        { error: { code: "not_found", message: "Event not found" } },
        404
      )
    }
    const input = c.req.valid("json")
    const name = input.name.trim()
    if (!name) {
      return c.json(
        { error: { code: "invalid_name", message: "Event name is required" } },
        400
      )
    }
    db.update(events)
      .set({
        name,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(events.id, eventId))
      .run()
    return c.json(getEvent(eventId))
  })

  app.delete("/api/events/:eventId", (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return c.json(
        { error: { code: "not_found", message: "Event not found" } },
        404
      )
    }
    const activeRun = db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(
        and(
          eq(challenges.eventId, eventId),
          inArray(runs.status, ["running", "paused"])
        )
      )
      .get()
    if (activeRun) {
      return c.json(
        {
          error: {
            code: "active_run",
            message: "Stop active runs before deleting this event",
          },
        },
        409
      )
    }
    const path = storage.eventPath(eventId)
    const trashedPath = storage.moveToTrash(path)
    try {
      db.delete(events).where(eq(events.id, eventId)).run()
    } catch (error) {
      if (trashedPath) storage.restore(trashedPath, path)
      throw error
    }
    storage.purge(trashedPath)
    return c.body(null, 204)
  })

  app.post(
    "/api/events/:eventId/challenges",
    validateJson(challengeInput),
    (c) => {
      const eventId = c.req.param("eventId")
      if (!getEvent(eventId)) {
        return c.json(
          { error: { code: "not_found", message: "Event not found" } },
          404
        )
      }
      const input = c.req.valid("json")
      const name = input.name.trim()
      if (!name || !input.description.trim()) {
        return c.json(
          {
            error: {
              code: "invalid_challenge",
              message: "Challenge name and description are required",
            },
          },
          400
        )
      }
      const now = new Date().toISOString()
      const challenge = {
        id: crypto.randomUUID(),
        eventId,
        name,
        description: input.description.trim(),
        category: cleanText(input.category),
        points: input.points ?? null,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(challenges).values(challenge).run()
      return c.json(
        {
          ...challenge,
          attachments: [],
          runCount: 0,
          status: "not_started",
        },
        201
      )
    }
  )

  app.patch(
    "/api/challenges/:challengeId",
    validateJson(challengeInput),
    (c) => {
      const challengeId = c.req.param("challengeId")
      if (!getChallenge(challengeId)) {
        return c.json(
          { error: { code: "not_found", message: "Challenge not found" } },
          404
        )
      }
      const input = c.req.valid("json")
      const name = input.name.trim()
      if (!name || !input.description.trim()) {
        return c.json(
          {
            error: {
              code: "invalid_challenge",
              message: "Challenge name and description are required",
            },
          },
          400
        )
      }
      db.update(challenges)
        .set({
          name,
          description: input.description.trim(),
          category: cleanText(input.category),
          points: input.points ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(challenges.id, challengeId))
        .run()
      return c.json(getChallenge(challengeId))
    }
  )

  app.delete("/api/challenges/:challengeId", (c) => {
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) {
      return c.json(
        { error: { code: "not_found", message: "Challenge not found" } },
        404
      )
    }
    const activeRun = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.challengeId, challenge.id),
          inArray(runs.status, ["running", "paused"])
        )
      )
      .get()
    if (activeRun) {
      return c.json(
        {
          error: {
            code: "active_run",
            message: "Stop active runs before deleting this challenge",
          },
        },
        409
      )
    }
    const path = storage.challengePath(challenge.eventId, challenge.id)
    const trashedPath = storage.moveToTrash(path)
    try {
      db.delete(challenges).where(eq(challenges.id, challenge.id)).run()
    } catch (error) {
      if (trashedPath) storage.restore(trashedPath, path)
      throw error
    }
    storage.purge(trashedPath)
    return c.body(null, 204)
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
              costKnown: false,
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
    if (!run) {
      return c.json(
        { error: { code: "not_found", message: "Run not found" } },
        404
      )
    }
    const agents = runManager.agents(run.id)
    const main = agents.find((agent) => agent.parentAgentId === null)
    return c.json({
      run,
      agents,
      history: main ? runManager.history(main.id) : [],
      stats: runManager.usage(run.id),
    })
  })

  app.get("/api/runs/:runId/agents/:agentId", (c) => {
    const run = runManager.get(c.req.param("runId"))
    const agent = runManager.agent(c.req.param("agentId"))
    if (!run || !agent || agent.runId !== run.id) {
      return c.json(
        { error: { code: "not_found", message: "Agent not found" } },
        404
      )
    }
    return c.json({
      agent,
      history: runManager.history(agent.id),
      stats: runManager.agentUsage(agent.id),
    })
  })

  app.get("/api/runs/:runId/agents/:agentId/inspector", (c) => {
    const run = runManager.get(c.req.param("runId"))
    const agent = runManager.agent(c.req.param("agentId"))
    if (!run || !agent || agent.runId !== run.id) {
      return c.json(
        { error: { code: "not_found", message: "Agent not found" } },
        404
      )
    }
    return c.json(runManager.inspector(agent.id))
  })

  app.get("/api/runs/:runId/stats", (c) => {
    const run = runManager.get(c.req.param("runId"))
    if (!run) {
      return c.json(
        { error: { code: "not_found", message: "Run not found" } },
        404
      )
    }
    return c.json({ runId: run.id, usage: runManager.usage(run.id) })
  })

  app.get("/api/challenges/:challengeId/stats", (c) => {
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) {
      return c.json(
        { error: { code: "not_found", message: "Challenge not found" } },
        404
      )
    }
    const challengeRuns = runManager.listForChallenge(challenge.id)
    const items = challengeRuns.map((run) => ({
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
    if (!event) {
      return c.json(
        { error: { code: "not_found", message: "Event not found" } },
        404
      )
    }
    const eventRuns = runManager.listForEvent(event.id)
    const items = eventRuns.map((run) => ({
      run,
      usage: runManager.usage(run.id),
    }))
    const challengeItems = db
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
      challenges: challengeItems,
      runs: items,
    })
  })

  app.get("/api/runs/:runId/files", (c) => {
    const workspacePath = runManager.workspacePath(c.req.param("runId"))
    if (!workspacePath) {
      return c.json(
        { error: { code: "not_found", message: "Run not found" } },
        404
      )
    }
    try {
      return c.json(readWorkspacePath(workspacePath, c.req.query("path") ?? ""))
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/runs/:runId/files/download", (c) => {
    const workspacePath = runManager.workspacePath(c.req.param("runId"))
    if (!workspacePath) {
      return c.json(
        { error: { code: "not_found", message: "Run not found" } },
        404
      )
    }
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
    if (!run) {
      return c.json(
        { error: { code: "not_found", message: "Run not found" } },
        404
      )
    }
    return streamSSE(c, async (stream) => {
      const pending: unknown[] = []
      let ready = false
      let finished = false
      let unsubscribe = () => {}
      let finish = () => {}
      const done = new Promise<void>((resolve) => {
        finish = () => {
          if (finished) return
          finished = true
          unsubscribe()
          resolve()
        }
      })
      unsubscribe = runManager.subscribe(runId, (event) => {
        if (!ready) pending.push(event)
        else void stream.writeSSE({ data: JSON.stringify(event) }).catch(finish)
      })
      c.req.raw.signal.addEventListener("abort", finish, { once: true })
      try {
        await stream.writeSSE({
          data: JSON.stringify({ type: "status", run: runManager.get(runId) }),
        })
        for (const agent of runManager.agents(runId)) {
          await stream.writeSSE({
            data: JSON.stringify({ type: "agent_status", agent }),
          })
        }
        while (pending.length > 0) {
          await stream.writeSSE({ data: JSON.stringify(pending.shift()) })
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
            c.req.valid("json").message.trim()
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
          c.req.valid("json").message
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

  app.post("/api/challenges/:challengeId/attachments", async (c) => {
    if (
      c.req.header("content-type")?.split(";", 1)[0] !==
      "application/octet-stream"
    ) {
      return c.json(
        {
          error: {
            code: "unsupported_media_type",
            message: "Attachment must use application/octet-stream",
          },
        },
        415
      )
    }
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) {
      return c.json(
        { error: { code: "not_found", message: "Challenge not found" } },
        404
      )
    }
    const filename = c.req.query("filename") ?? ""
    if (!isSafeFilename(filename)) {
      return c.json(
        {
          error: {
            code: "invalid_filename",
            message: "Attachment filename is not allowed",
          },
        },
        400
      )
    }
    const id = crypto.randomUUID()
    const storageKey = `${challenge.eventId}/${challenge.id}/${id}`
    const metadata = await storage.write(storageKey, c.req.raw.body)
    const attachment = {
      id,
      challengeId: challenge.id,
      originalName: filename,
      storageKey,
      ...metadata,
      createdAt: new Date().toISOString(),
    }
    try {
      db.insert(attachments).values(attachment).run()
    } catch (error) {
      storage.remove(storageKey)
      throw error
    }
    const { storageKey: _, ...response } = attachment
    return c.json({ ...response, downloadUrl: `/api/attachments/${id}` }, 201)
  })

  app.get("/api/attachments/:attachmentId", (c) => {
    const attachment = db
      .select()
      .from(attachments)
      .where(eq(attachments.id, c.req.param("attachmentId")))
      .get()
    if (!attachment) {
      return c.json(
        { error: { code: "not_found", message: "Attachment not found" } },
        404
      )
    }
    const path = storage.attachmentPath(attachment.storageKey)
    if (!existsSync(path)) {
      return c.json(
        { error: { code: "not_found", message: "Attachment not found" } },
        404
      )
    }
    return new Response(Bun.file(path), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
      },
    })
  })

  app.delete("/api/attachments/:attachmentId", (c) => {
    const attachment = db
      .select()
      .from(attachments)
      .where(eq(attachments.id, c.req.param("attachmentId")))
      .get()
    if (!attachment) {
      return c.json(
        { error: { code: "not_found", message: "Attachment not found" } },
        404
      )
    }
    const path = storage.attachmentPath(attachment.storageKey)
    const trashedPath = storage.moveToTrash(path)
    try {
      db.delete(attachments).where(eq(attachments.id, attachment.id)).run()
    } catch (error) {
      if (trashedPath) storage.restore(trashedPath, path)
      throw error
    }
    storage.purge(trashedPath)
    return c.body(null, 204)
  })

  return {
    app,
    activeSessionCount: runManager.activeSessionCount,
    close: () => {
      runManager.close()
      sqlite.close()
    },
  }
}

function runError(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  error: unknown
) {
  if (!(error instanceof RunActionError)) throw error
  const status = error.code === "not_found" ? 404 : 409
  return c.json({ error: { code: error.code, message: error.message } }, status)
}

function workspaceFileError(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  error: unknown
) {
  if (!(error instanceof WorkspaceFileError)) throw error
  const status = error.code === "not_found" ? 404 : 400
  return c.json({ error: { code: error.code, message: error.message } }, status)
}
