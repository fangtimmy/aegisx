import { basename } from "node:path"
import { and, eq } from "drizzle-orm"
import type { createDatabase } from "./db"
import { attachments, challenges, events } from "./db/schema"
import {
  type CtfPlatformAdapter,
  createPlatformAdapter,
  type PlatformConfig,
  PlatformError,
  type PlatformType,
  type RemoteAttachment,
  type RemoteChallenge,
  type SubmissionResult,
  type TargetState,
} from "./platform"
import type { createStorage } from "./storage"

type Database = ReturnType<typeof createDatabase>["db"]
type Storage = ReturnType<typeof createStorage>

export class PlatformActionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_bound"
      | "invalid_state"
      | "platform_error",
    message: string
  ) {
    super(message)
  }
}

export function createPlatformService(db: Database, storage: Storage) {
  function storedEvent(eventId: string) {
    return db.select().from(events).where(eq(events.id, eventId)).get()
  }

  function configForEvent(eventId: string): PlatformConfig | undefined {
    const event = storedEvent(eventId)
    if (
      !event?.platformType ||
      !event.platformBaseUrl ||
      !event.platformCredential ||
      !event.remoteEventId
    ) {
      return undefined
    }
    return {
      type: event.platformType as PlatformType,
      baseUrl: event.platformBaseUrl,
      credential: event.platformCredential,
      remoteEventId: event.remoteEventId,
    }
  }

  function adapterForEvent(eventId: string) {
    const config = configForEvent(eventId)
    if (!config) return undefined
    return createPlatformAdapter(config, (credential) => {
      db.update(events)
        .set({
          platformCredential: credential,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(events.id, eventId))
        .run()
    })
  }

  async function syncAttachment(
    eventId: string,
    challengeId: string,
    remote: RemoteAttachment,
    adapter: CtfPlatformAdapter
  ) {
    const existing = db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.challengeId, challengeId),
          eq(attachments.remoteId, remote.id)
        )
      )
      .get()
    const id = existing?.id ?? crypto.randomUUID()
    const storageKey = existing?.storageKey ?? `${eventId}/${challengeId}/${id}`
    const response = await adapter.downloadAttachment(remote)
    if (!response.body) {
      throw new PlatformActionError(
        "platform_error",
        `Attachment ${remote.filename} has no content`
      )
    }
    const metadata = await storage.write(storageKey, response.body)
    const now = new Date().toISOString()
    const values = {
      challengeId,
      originalName: basename(remote.filename) || "attachment",
      storageKey,
      remoteId: remote.id,
      ...metadata,
      createdAt: existing?.createdAt ?? now,
    }
    if (existing) {
      db.update(attachments)
        .set(values)
        .where(eq(attachments.id, existing.id))
        .run()
    } else {
      db.insert(attachments)
        .values({ id, ...values })
        .run()
    }
  }

  async function syncRemoteChallenge(
    eventId: string,
    remote: RemoteChallenge,
    adapter: CtfPlatformAdapter
  ) {
    const existing = db
      .select()
      .from(challenges)
      .where(
        and(eq(challenges.eventId, eventId), eq(challenges.remoteId, remote.id))
      )
      .get()
    const id = existing?.id ?? crypto.randomUUID()
    const now = new Date().toISOString()
    const values = {
      eventId,
      name: remote.name,
      description: remote.description || "No challenge description provided.",
      category: remote.category,
      points: remote.points,
      remoteId: remote.id,
      remoteSolved: remote.solved,
      remoteTarget: remote.targetSupported,
      remoteUpdatedAt: now,
      updatedAt: now,
    }
    if (existing) {
      db.update(challenges).set(values).where(eq(challenges.id, id)).run()
    } else {
      db.insert(challenges)
        .values({ id, ...values, createdAt: now })
        .run()
    }

    for (const attachment of remote.attachments) {
      await syncAttachment(eventId, id, attachment, adapter)
    }
    const liveIds = new Set(
      remote.attachments.map((attachment) => attachment.id)
    )
    const stale = db
      .select()
      .from(attachments)
      .where(eq(attachments.challengeId, id))
      .all()
      .filter(
        (attachment) =>
          attachment.remoteId !== null && !liveIds.has(attachment.remoteId)
      )
    for (const attachment of stale) {
      db.delete(attachments).where(eq(attachments.id, attachment.id)).run()
      storage.remove(attachment.storageKey)
    }
    return { id, remote }
  }

  async function listRemoteChallenges(eventId: string) {
    const adapter = adapterForEvent(eventId)
    if (!adapter) {
      throw new PlatformActionError(
        "not_bound",
        "Event is not bound to a platform"
      )
    }
    try {
      return (await adapter.listChallenges()).map((challenge) => ({
        id: challenge.id,
        name: challenge.name,
        category: challenge.category,
        points: challenge.points,
        solved: challenge.solved,
      }))
    } catch (error) {
      throw platformError(error)
    }
  }

  async function importChallenges(eventId: string, remoteIds: string[]) {
    const adapter = adapterForEvent(eventId)
    if (!adapter) {
      throw new PlatformActionError(
        "not_bound",
        "Event is not bound to a platform"
      )
    }
    try {
      const remoteChallenges = await Promise.all(
        [...new Set(remoteIds)].map((remoteId) =>
          adapter.getChallenge(remoteId)
        )
      )
      for (const challenge of remoteChallenges) {
        await syncRemoteChallenge(eventId, challenge, adapter)
      }
      const now = new Date().toISOString()
      db.update(events)
        .set({ lastSyncedAt: now, updatedAt: now })
        .where(eq(events.id, eventId))
        .run()
      return { syncedAt: now, challengeCount: remoteChallenges.length }
    } catch (error) {
      throw platformError(error)
    }
  }

  async function bind(
    eventId: string,
    input: {
      type: PlatformType
      baseUrl: string
      credential: string
      remoteEventId: string
    }
  ) {
    const event = storedEvent(eventId)
    if (!event) throw new PlatformActionError("not_found", "Event not found")
    if (!event.platformType) {
      const localChallenge = db
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.eventId, eventId))
        .get()
      if (localChallenge) {
        throw new PlatformActionError(
          "invalid_state",
          "Only an empty event can be bound to a platform"
        )
      }
    }
    const config: PlatformConfig = {
      ...input,
      remoteEventId: input.type === "ctfd" ? "site" : input.remoteEventId,
    }
    try {
      const remoteEvents = await createPlatformAdapter(config).listEvents()
      if (!remoteEvents.some((remote) => remote.id === config.remoteEventId)) {
        throw new PlatformActionError("not_found", "Remote event not found")
      }
    } catch (error) {
      throw platformError(error)
    }
    const now = new Date().toISOString()
    db.update(events)
      .set({
        platformType: config.type,
        platformBaseUrl: normalizeBaseUrl(config.baseUrl),
        platformCredential: config.credential,
        remoteEventId: config.remoteEventId,
        lastSyncedAt: null,
        updatedAt: now,
      })
      .where(eq(events.id, eventId))
      .run()
    return { bound: true }
  }

  function detach(eventId: string) {
    const event = storedEvent(eventId)
    if (!event) throw new PlatformActionError("not_found", "Event not found")
    db.transaction((tx) => {
      const eventChallenges = tx
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.eventId, eventId))
        .all()
      for (const challenge of eventChallenges) {
        tx.update(attachments)
          .set({ remoteId: null })
          .where(eq(attachments.challengeId, challenge.id))
          .run()
      }
      tx.update(challenges)
        .set({ remoteId: null, remoteTarget: false, remoteUpdatedAt: null })
        .where(eq(challenges.eventId, eventId))
        .run()
      tx.update(events)
        .set({
          platformType: null,
          platformBaseUrl: null,
          platformCredential: null,
          remoteEventId: null,
          lastSyncedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(events.id, eventId))
        .run()
    })
  }

  async function listRemoteEvents(input: {
    type: PlatformType
    baseUrl: string
    credential: string
  }) {
    try {
      return await createPlatformAdapter({
        ...input,
        remoteEventId: input.type === "ctfd" ? "site" : "",
      }).listEvents()
    } catch (error) {
      throw platformError(error)
    }
  }

  async function prepareChallenge(challengeId: string) {
    const row = db
      .select({ challenge: challenges, event: events })
      .from(challenges)
      .innerJoin(events, eq(challenges.eventId, events.id))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row?.challenge.remoteId || !row.event.platformType) return undefined
    const adapter = adapterForEvent(row.event.id)
    if (!adapter) return undefined
    try {
      const remote = await adapter.getChallenge(row.challenge.remoteId)
      await syncRemoteChallenge(row.event.id, remote, adapter)
      if (!remote.targetSupported || !adapter.getTarget) return undefined
      let target = await adapter.getTarget(remote.id)
      if (target.status === "absent" && adapter.startTarget) {
        target = await adapter.startTarget(remote.id)
      }
      return waitForTarget(adapter, remote.id, target)
    } catch (error) {
      throw platformError(error)
    }
  }

  async function submitFlag(challengeId: string, flag?: string) {
    const row = db
      .select({ challenge: challenges, eventId: events.id })
      .from(challenges)
      .innerJoin(events, eq(challenges.eventId, events.id))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row?.challenge.remoteId || !configForEvent(row.eventId))
      return undefined
    if (!flag?.trim()) {
      throw new PlatformActionError(
        "invalid_state",
        "A flag is required for a platform challenge"
      )
    }
    const adapter = adapterForEvent(row.eventId) as CtfPlatformAdapter
    try {
      let result = await adapter.submitFlag(row.challenge.remoteId, flag.trim())
      for (
        let attempt = 0;
        result.status === "pending" && attempt < 60;
        attempt += 1
      ) {
        if (!result.remoteId || !adapter.getSubmission) break
        await Bun.sleep(1000)
        result = await adapter.getSubmission(
          row.challenge.remoteId,
          result.remoteId
        )
      }
      if (result.status === "accepted" || result.status === "already_solved") {
        db.update(challenges)
          .set({ remoteSolved: true, updatedAt: new Date().toISOString() })
          .where(eq(challenges.id, challengeId))
          .run()
        return result
      }
      throw new PlatformActionError(
        "platform_error",
        result.message ?? submissionMessage(result)
      )
    } catch (error) {
      throw platformError(error)
    }
  }

  async function targetAction(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop"
  ) {
    const row = db
      .select({ remoteId: challenges.remoteId, eventId: events.id })
      .from(challenges)
      .innerJoin(events, eq(challenges.eventId, events.id))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row?.remoteId) {
      throw new PlatformActionError(
        "not_bound",
        "Challenge is not platform managed"
      )
    }
    const adapter = adapterForEvent(row.eventId)
    const method =
      action === "get"
        ? adapter?.getTarget
        : action === "start"
          ? adapter?.startTarget
          : action === "extend"
            ? adapter?.extendTarget
            : adapter?.stopTarget
    if (!method) {
      throw new PlatformActionError(
        "invalid_state",
        "Platform does not support target management"
      )
    }
    try {
      return await method.call(adapter, row.remoteId)
    } catch (error) {
      throw platformError(error)
    }
  }

  return {
    bind,
    detach,
    importChallenges,
    listRemoteChallenges,
    listRemoteEvents,
    prepareChallenge,
    submitFlag,
    targetAction,
    isBoundEvent: (eventId: string) => Boolean(configForEvent(eventId)),
  }
}

async function waitForTarget(
  adapter: CtfPlatformAdapter,
  remoteId: string,
  initial: TargetState
) {
  let target = initial
  for (
    let attempt = 0;
    target.status === "starting" && attempt < 60;
    attempt += 1
  ) {
    await Bun.sleep(1000)
    target = (await adapter.getTarget?.(remoteId)) ?? target
  }
  if (target.status !== "running") {
    throw new PlatformActionError(
      "platform_error",
      target.message ?? "Challenge target did not become ready"
    )
  }
  return target
}

function normalizeBaseUrl(value: string) {
  return new URL(value.trim()).toString().replace(/\/$/, "")
}

function platformError(error: unknown): PlatformActionError {
  if (error instanceof PlatformActionError) return error
  if (error instanceof PlatformError) {
    return new PlatformActionError("platform_error", error.message)
  }
  return new PlatformActionError("platform_error", "Platform request failed")
}

function submissionMessage(result: SubmissionResult) {
  if (result.status === "rejected") return "The platform rejected the flag"
  if (result.status === "partial")
    return "The platform accepted only a partial solve"
  if (result.status === "rate_limited")
    return "The platform rate limited submissions"
  if (result.status === "pending") return "Platform judging timed out"
  return "Platform submission failed"
}
