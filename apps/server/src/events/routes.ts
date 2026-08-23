import { existsSync } from "node:fs"

import { get, LIVE_AGENT_STATUSES, type AgentUsage } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { agents, attachments, challenges, events } from "../db/schema"
import {
  badRequest,
  conflict,
  notFound,
  payloadTooLarge,
  unsupportedMediaType,
} from "../infrastructure/http-errors"
import type { createStorage } from "../infrastructure/storage"
import { isSafeFilename, StorageLimitError } from "../infrastructure/storage"
import { validateJson } from "../infrastructure/validation"
import { platformActionHttpError } from "../platforms/errors"
import type { createPlatformService } from "../platforms/service"
import type { createCatalogReader } from "./catalog"

const createEventInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 160 }),
    promptHint: Type.Optional(Type.String({ maxLength: 10_000 })),
  },
  { additionalProperties: false }
)

/** PATCH is a partial update — name/promptHint are individually optional, so
 * the frontend can save the prompt hint without resubmitting the name. */
const updateEventInput = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    promptHint: Type.Optional(Type.String({ maxLength: 10_000 })),
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

const solveStateInput = Type.Object(
  {
    state: Type.Union([
      Type.Literal("solved"),
      Type.Literal("partial"),
      Type.Literal("unsolved"),
    ]),
  },
  { additionalProperties: false }
)

const manualFlagInput = Type.Object(
  { flag: Type.String({ minLength: 1, maxLength: 10_000 }) },
  { additionalProperties: false }
)

type Storage = ReturnType<typeof createStorage>
type PlatformService = ReturnType<typeof createPlatformService>
type AgentManager = {
  usageForEvent(eventId: string): AgentUsage | undefined
  deleteAgentsForEvent(eventId: string, scope: "solver" | "all"): Promise<void>
}

export function registerEventRoutes(
  app: Hono,
  options: {
    db: Database
    storage: Storage
    platformService: PlatformService
    agentManager: AgentManager
    getSettings(): { "runtime.maxAttachmentMb": number }
    catalog: Pick<
      ReturnType<typeof createCatalogReader>,
      "getEvent" | "getChallenge" | "listEvents" | "listChallengesForEvent"
    >
    /** v18 §八: sweep the challenge's team:<cid> data (messages + cursors +
     * shared copies) when the challenge is deleted. */
    cleanupChallengeChannels(challengeId: string): void
    /** Remove the challenge workspace tree (agents/ shared/ attachments/
     * sessions/ runtime/) on challenge deletion. */
    deleteChallengeWorkspace(eventId: string, challengeId: string): void
    /** v18 §八: sweep ALL channel data tied to the event (orch:<eid> + every
     * team of the event's challenges + every dm of the event's agents) —
     * MUST run before the event row delete cascades the entities the key
     * enumeration needs. */
    cleanupEventChannels(eventId: string): void
    /** Remove the orchestrator workspace + every challenge workspace of the
     * event on event deletion. */
    deleteEventWorkspaces(eventId: string): void
    /** Drop the event's in-memory queue bookkeeping (starved edge memory);
     * the queue's DB rows cascade away with the event row itself. */
    cleanupQueueState(eventId: string): void
  }
) {
  const { db, storage, platformService, agentManager, catalog } = options
  // Method references through the options/catalog objects (not destructured)
  // so `this` survives (oxlint unbound-method).
  const getSettings = () => options.getSettings()
  const getEvent = (eventId: string) => catalog.getEvent(eventId)
  const getChallenge = (challengeId: string) =>
    catalog.getChallenge(challengeId)
  const listEvents = () => catalog.listEvents()
  const listChallengesForEvent = (eventId: string) =>
    catalog.listChallengesForEvent(eventId)

  app.get("/api/events", (c) => c.json({ items: listEvents() }))

  app.post("/api/events", validateJson(createEventInput), (c) => {
    const input = c.req.valid("json")
    const now = new Date().toISOString()
    const event = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      promptHint: input.promptHint?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
    }
    if (!event.name) {
      return badRequest(c, "invalid_name", "Event name is required")
    }
    db.insert(events).values(event).run()
    return c.json(
      {
        ...event,
        challengeCount: 0,
        solvedCount: 0,
        activeAgentCount: 0,
        lastActivityAt: now,
        platform: null,
      },
      201
    )
  })

  app.get("/api/events/:eventId", (c) => {
    const event = getEvent(c.req.param("eventId"))
    if (!event) {
      return notFound(c, "Event not found")
    }
    return c.json({ event, challenges: listChallengesForEvent(event.id) })
  })

  app.get("/api/events/:eventId/usage", (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return notFound(c, "Event not found")
    }
    return c.json({ usage: agentManager.usageForEvent(eventId) })
  })

  app.patch("/api/events/:eventId", validateJson(updateEventInput), (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return notFound(c, "Event not found")
    }
    const input = c.req.valid("json")
    const updates: { name?: string; promptHint?: string; updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    }
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) {
        return badRequest(c, "invalid_name", "Event name is required")
      }
      updates.name = name
    }
    if (input.promptHint !== undefined) {
      updates.promptHint = input.promptHint.trim()
    }
    db.update(events).set(updates).where(eq(events.id, eventId)).run()
    return c.json(getEvent(eventId))
  })

  app.delete("/api/events/:eventId", async (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return notFound(c, "Event not found")
    }
    // Any live agent (solver OR scheduler — both carry eventId) blocks the
    // delete: cascading the row away while its session + container keep
    // running would orphan them (burning tokens).
    const liveAgent = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.eventId, eventId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .get()
    if (liveAgent) {
      return conflict(
        c,
        "active_agent",
        "Close live agents / stop the scheduler before deleting this event"
      )
    }
    try {
      await platformService.assertNoActiveTargets(eventId)
    } catch (error) {
      return platformActionHttpError(c, error)
    }
    const path = storage.eventPath(eventId)
    const trashedPath = storage.moveToTrash(path)
    try {
      // v18 §八: derived-key channel data has no FK cascade — sweep it while
      // the challenge/agent rows still exist (the enumeration needs them).
      options.cleanupEventChannels(eventId)
      options.deleteEventWorkspaces(eventId)
      options.cleanupQueueState(eventId)
      db.delete(events).where(eq(events.id, eventId)).run()
    } catch (error) {
      if (trashedPath) storage.restore(trashedPath, path)
      throw error
    }
    storage.purge(trashedPath)
    return c.body(null, 204)
  })

  // Event-settings danger zone: wipe every solver agent of the event (the
  // scheduler agent included with ?scope=all — live agents are forcibly
  // closed, same as the per-agent delete). Pending queue items stay: queued
  // work is not history.
  app.delete("/api/events/:eventId/agents", async (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return notFound(c, "Event not found")
    }
    const scope = c.req.query("scope") === "all" ? "all" : "solver"
    await agentManager.deleteAgentsForEvent(eventId, scope)
    return c.body(null, 204)
  })

  // Event-settings danger zone: wipe every challenge of the event — the
  // challenges' agents first (same live-agent guard as the per-challenge
  // delete), then team:<cid> channel sweeps and attachment dirs
  // (trash-restored on error).
  app.delete("/api/events/:eventId/challenges", async (c) => {
    const eventId = c.req.param("eventId")
    if (!getEvent(eventId)) {
      return notFound(c, "Event not found")
    }
    const liveChallengeAgent = db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(challenges, eq(agents.challengeId, challenges.id))
      .where(
        and(
          eq(challenges.eventId, eventId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .get()
    if (liveChallengeAgent) {
      return conflict(
        c,
        "active_agent",
        "Close live agents before deleting this event's challenges"
      )
    }
    try {
      await platformService.assertNoActiveTargets(eventId)
    } catch (error) {
      return platformActionHttpError(c, error)
    }
    await agentManager.deleteAgentsForEvent(eventId, "solver")
    const items = listChallengesForEvent(eventId)
    const trashedPaths: Array<[trashedPath: string, path: string]> = []
    try {
      for (const challenge of items) {
        options.cleanupChallengeChannels(challenge.id)
        options.deleteChallengeWorkspace(eventId, challenge.id)
        const path = storage.challengePath(eventId, challenge.id)
        const trashedPath = storage.moveToTrash(path)
        if (trashedPath) trashedPaths.push([trashedPath, path])
      }
      db.delete(challenges).where(eq(challenges.eventId, eventId)).run()
    } catch (error) {
      for (const [trashedPath, path] of trashedPaths) {
        storage.restore(trashedPath, path)
      }
      throw error
    }
    for (const [trashedPath] of trashedPaths) {
      storage.purge(trashedPath)
    }
    return c.body(null, 204)
  })

  app.post(
    "/api/events/:eventId/challenges",
    validateJson(challengeInput),
    (c) => {
      const eventId = c.req.param("eventId")
      if (!getEvent(eventId)) {
        return notFound(c, "Event not found")
      }
      const input = c.req.valid("json")
      const name = input.name.trim()
      if (!name || !input.description.trim()) {
        return badRequest(
          c,
          "invalid_challenge",
          "Challenge name and description are required"
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
        return notFound(c, "Challenge not found")
      }
      const input = c.req.valid("json")
      const name = input.name.trim()
      if (!name || !input.description.trim()) {
        return badRequest(
          c,
          "invalid_challenge",
          "Challenge name and description are required"
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

  // Single-challenge detail (SDK `challenges.get`; the scheduler's in-process
  // get_challenge already had this — the HTTP layer lacked it).
  app.get("/api/challenges/:challengeId", (c) => {
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) return notFound(c, "Challenge not found")
    return c.json(challenge)
  })

  app.patch(
    "/api/challenges/:challengeId/solved",
    validateJson(solveStateInput),
    (c) => {
      const challengeId = c.req.param("challengeId")
      if (!getChallenge(challengeId)) {
        return notFound(c, "Challenge not found")
      }
      const { state } = c.req.valid("json")
      db.update(challenges)
        .set({ manualSolveState: state, updatedAt: new Date().toISOString() })
        .where(eq(challenges.id, challengeId))
        .run()
      return c.json(getChallenge(challengeId))
    }
  )

  app.post(
    "/api/challenges/:challengeId/flags",
    validateJson(manualFlagInput),
    (c) => {
      const challengeId = c.req.param("challengeId")
      if (!getChallenge(challengeId)) {
        return notFound(c, "Challenge not found")
      }
      const flag = platformService.addManualFlag(
        challengeId,
        c.req.valid("json").flag
      )
      return c.json({ flag }, 201)
    }
  )

  app.delete("/api/challenges/:challengeId/flags/:flagId", (c) => {
    const challengeId = c.req.param("challengeId")
    if (!getChallenge(challengeId)) {
      return notFound(c, "Challenge not found")
    }
    const deleted = platformService.deleteFlag(
      challengeId,
      c.req.param("flagId")
    )
    if (!deleted) return notFound(c, "Flag not found")
    return c.body(null, 204)
  })

  app.post("/api/challenges/:challengeId/remote/refresh", async (c) => {
    const challengeId = c.req.param("challengeId")
    if (!getChallenge(challengeId)) {
      return notFound(c, "Challenge not found")
    }
    try {
      await platformService.refreshChallengeRemote(challengeId)
      return c.json(getChallenge(challengeId))
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  app.delete("/api/challenges/:challengeId", (c) => {
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) {
      return notFound(c, "Challenge not found")
    }
    const liveAgent = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challenge.id),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .get()
    if (liveAgent) {
      return conflict(
        c,
        "active_agent",
        "Close live agents before deleting this challenge"
      )
    }
    const path = storage.challengePath(challenge.eventId, challenge.id)
    const trashedPath = storage.moveToTrash(path)
    try {
      // v18 §八: the team:<cid> knowledge base has no FK cascade — sweep it
      // (messages + cursors + shared copies) with the challenge.
      options.cleanupChallengeChannels(challenge.id)
      options.deleteChallengeWorkspace(challenge.eventId, challenge.id)
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
      return unsupportedMediaType(
        c,
        "unsupported_media_type",
        "Attachment must use application/octet-stream"
      )
    }
    const challenge = getChallenge(c.req.param("challengeId"))
    if (!challenge) {
      return notFound(c, "Challenge not found")
    }
    const filename = c.req.query("filename") ?? ""
    if (!isSafeFilename(filename)) {
      return badRequest(
        c,
        "invalid_filename",
        "Attachment filename is not allowed"
      )
    }
    const id = crypto.randomUUID()
    const storageKey = `${challenge.eventId}/${challenge.id}/${id}`
    let metadata: { size: number; sha256: string }
    try {
      metadata = await storage.write(
        storageKey,
        c.req.raw.body,
        get(getSettings(), "runtime.maxAttachmentMb") * 1024 * 1024
      )
    } catch (error) {
      if (error instanceof StorageLimitError) {
        return payloadTooLarge(c, "attachment_too_large", error.message)
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
      return notFound(c, "Attachment not found")
    }
    const path = storage.attachmentPath(attachment.storageKey)
    if (!existsSync(path)) {
      return notFound(c, "Attachment not found")
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
      return notFound(c, "Attachment not found")
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
