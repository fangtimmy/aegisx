import { existsSync } from "node:fs"
import type { Api, Model } from "@earendil-works/pi-ai/compat"
import type { AuthStorage } from "@earendil-works/pi-coding-agent"
import { tbValidator } from "@hono/typebox-validator"
import { and, count, eq, getTableColumns, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Type } from "typebox"
import { createDatabase } from "./db"
import { attachments, challenges, events, runs } from "./db/schema"
import { createRunManager, RunActionError } from "./runs"
import { createStorage, isSafeFilename } from "./storage"

const eventInput = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.String({ maxLength: 50_000 }),
  startsAt: Type.Optional(
    Type.Union([Type.String({ maxLength: 64 }), Type.Null()])
  ),
  endsAt: Type.Optional(
    Type.Union([Type.String({ maxLength: 64 }), Type.Null()])
  ),
})

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
    provider: Type.String({ minLength: 1, maxLength: 100 }),
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
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

const validateJson = <T extends Parameters<typeof tbValidator>[1]>(schema: T) =>
  tbValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: { code: "invalid_request", message: "Invalid request body" } },
        400
      )
    }
  })

function cleanText(value: string | null | undefined) {
  const cleaned = value?.trim()
  return cleaned ? cleaned : null
}

function cleanDate(value: string | null | undefined) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

export function createApp(options: {
  dataDir: string
  maxConcurrency?: number
  authStorage?: AuthStorage
  resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined
}) {
  const { db, sqlite } = createDatabase(options.dataDir)
  const storage = createStorage(options.dataDir)
  const configuredConcurrency =
    options.maxConcurrency ?? Number(process.env.AEGISX_MAX_CONCURRENCY ?? 2)
  const runManager = createRunManager({
    db,
    dataDir: options.dataDir,
    maxConcurrency:
      Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency
        : 2,
    authStorage: options.authStorage,
    resolveModel: options.resolveModel,
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

  app.onError((_error, c) => {
    console.error("Request failed")
    return c.json(
      { error: { code: "internal_error", message: "Request failed" } },
      500
    )
  })

  app.get("/", (c) => c.json({ name: "AegisX", status: "ok" }))

  app.get("/api/events", (c) => c.json({ items: listEvents() }))

  app.post("/api/events", validateJson(eventInput), (c) => {
    const input = c.req.valid("json")
    const startsAt = cleanDate(input.startsAt)
    const endsAt = cleanDate(input.endsAt)
    if (startsAt === undefined || endsAt === undefined) {
      return c.json(
        { error: { code: "invalid_date", message: "Invalid event date" } },
        400
      )
    }
    if (startsAt && endsAt && startsAt > endsAt) {
      return c.json(
        {
          error: {
            code: "invalid_date_range",
            message: "End time must be after start time",
          },
        },
        400
      )
    }
    const now = new Date().toISOString()
    const event = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      description: input.description.trim(),
      startsAt,
      endsAt,
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
    const startsAt = cleanDate(input.startsAt)
    const endsAt = cleanDate(input.endsAt)
    if (startsAt === undefined || endsAt === undefined) {
      return c.json(
        { error: { code: "invalid_date", message: "Invalid event date" } },
        400
      )
    }
    if (startsAt && endsAt && startsAt > endsAt) {
      return c.json(
        {
          error: {
            code: "invalid_date_range",
            message: "End time must be after start time",
          },
        },
        400
      )
    }
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
        description: input.description.trim(),
        startsAt,
        endsAt,
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
        return c.json(
          await runManager.create(
            c.req.param("challengeId"),
            input.provider,
            input.modelId
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
    return c.json({ run, history: runManager.history(run.id) })
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
      await stream.writeSSE({
        data: JSON.stringify({ type: "status", run }),
      })
      await new Promise<void>((resolve) => {
        let unsubscribe = () => {}
        const finish = () => {
          unsubscribe()
          resolve()
        }
        unsubscribe = runManager.subscribe(runId, (event) => {
          void stream.writeSSE({ data: JSON.stringify(event) }).catch(finish)
        })
        c.req.raw.signal.addEventListener("abort", finish, { once: true })
      })
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
