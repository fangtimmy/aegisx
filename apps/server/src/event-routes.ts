import { existsSync } from "node:fs"
import { and, eq, inArray } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"
import type { createCatalogReader } from "./catalog"
import type { createDatabase } from "./db"
import { attachments, challenges, events, runs } from "./db/schema"
import type { createPlatformService } from "./platform-service"
import { PlatformActionError } from "./platform-service"
import type { createRunManager } from "./runs"
import type { createStorage } from "./storage"
import { isSafeFilename, StorageLimitError } from "./storage"
import { validateJson } from "./validation"

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

type Database = ReturnType<typeof createDatabase>["db"]
type Storage = ReturnType<typeof createStorage>
type PlatformService = ReturnType<typeof createPlatformService>
type RunManager = ReturnType<typeof createRunManager>

export function registerEventRoutes(
  app: Hono,
  options: {
    db: Database
    storage: Storage
    platformService: PlatformService
    runManager: RunManager
    getSettings(): { maxAttachmentMb: number }
    catalog: Pick<
      ReturnType<typeof createCatalogReader>,
      "getEvent" | "getChallenge" | "listEvents" | "listChallengesForEvent"
    >
  }
) {
  const { db, storage, platformService, runManager, getSettings, catalog } =
    options
  const { getEvent, getChallenge, listEvents, listChallengesForEvent } = catalog

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
    return c.json(
      {
        ...event,
        challengeCount: 0,
        solvedCount: 0,
        activeRunCount: 0,
        lastActivityAt: now,
        platform: null,
      },
      201
    )
  })

  app.get("/api/events/:eventId", (c) => {
    const event = getEvent(c.req.param("eventId"))
    if (!event) {
      return c.json(
        { error: { code: "not_found", message: "Event not found" } },
        404
      )
    }
    return c.json({ event, challenges: listChallengesForEvent(event.id) })
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
    const name = c.req.valid("json").name.trim()
    if (!name) {
      return c.json(
        { error: { code: "invalid_name", message: "Event name is required" } },
        400
      )
    }
    db.update(events)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(events.id, eventId))
      .run()
    return c.json(getEvent(eventId))
  })

  app.delete("/api/events/:eventId", async (c) => {
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
    try {
      await platformService.assertNoActiveTargets(eventId)
    } catch (error) {
      if (!(error instanceof PlatformActionError)) throw error
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === "platform_error" ? 502 : 409
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
      return c.json(getChallenge(challenge.id), 201)
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
    if (challenge.remoteId && platformService.isBoundEvent(challenge.eventId)) {
      return c.json(
        {
          error: {
            code: "platform_managed",
            message: "Platform-managed challenges must be synchronized",
          },
        },
        409
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
    let metadata: { size: number; sha256: string }
    try {
      metadata = await storage.write(
        storageKey,
        c.req.raw.body,
        getSettings().maxAttachmentMb * 1024 * 1024
      )
    } catch (error) {
      if (error instanceof StorageLimitError) {
        return c.json(
          { error: { code: "attachment_too_large", message: error.message } },
          413
        )
      }
      throw error
    }
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
}

function cleanText(value: string | null | undefined) {
  const cleaned = value?.trim()
  return cleaned ? cleaned : null
}
