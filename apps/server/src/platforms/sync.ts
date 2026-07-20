import { basename } from "node:path"
import { and, eq } from "drizzle-orm"
import type { createDatabase } from "../db"
import { attachments, challenges, eventPlatforms } from "../db/schema"
import type { createStorage } from "../infrastructure/storage"
import {
  type CtfPlatformAdapter,
  PlatformError,
  type RemoteAttachment,
  type RemoteChallenge,
  type RemoteChallengeSummary,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type Storage = ReturnType<typeof createStorage>
type StoredPlatform = typeof eventPlatforms.$inferSelect

export function createPlatformSync(
  db: Database,
  storage: Storage,
  maxAttachmentBytes: () => number,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined
) {
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
    const metadata = await storage.write(
      storageKey,
      response.body,
      maxAttachmentBytes()
    )
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
    sourceKey: string,
    remote: RemoteChallenge,
    adapter: CtfPlatformAdapter
  ) {
    const existing = db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.eventId, eventId),
          eq(challenges.remoteSourceKey, sourceKey),
          eq(challenges.remoteId, remote.id)
        )
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
      remoteSourceKey: sourceKey,
      remoteId: remote.id,
      remoteAvailable: true,
      remoteSolved: existing?.remoteSolved === true || remote.solved,
      remoteTarget: remote.targetSupported,
      remoteTargetCount: remote.targetCount,
      remoteTargetInfo: JSON.stringify(remote.targets),
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

    try {
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
    } catch (error) {
      if (!existing) {
        db.delete(challenges).where(eq(challenges.id, id)).run()
        storage.purge(storage.challengePath(eventId, id))
      }
      throw error
    }
    return { id, created: !existing }
  }

  async function discoverInventory(eventId: string) {
    const platform = storedPlatform(eventId)
    const adapter = adapterForEvent(eventId)
    if (!platform || !adapter) {
      throw new PlatformActionError(
        "not_bound",
        "Event is not connected to a platform"
      )
    }
    let remote: RemoteChallengeSummary[]
    try {
      remote = await adapter.listChallenges()
    } catch (error) {
      throw platformError(error)
    }
    const now = new Date().toISOString()
    db.transaction((tx) => {
      tx.update(challenges)
        .set({ remoteAvailable: false })
        .where(
          and(
            eq(challenges.eventId, eventId),
            eq(challenges.remoteSourceKey, platform.sourceKey)
          )
        )
        .run()
      for (const item of remote) {
        tx.update(challenges)
          .set({
            remoteAvailable: true,
            ...(item.solved ? { remoteSolved: true } : {}),
          })
          .where(
            and(
              eq(challenges.eventId, eventId),
              eq(challenges.remoteSourceKey, platform.sourceKey),
              eq(challenges.remoteId, item.id)
            )
          )
          .run()
      }
      tx.update(eventPlatforms)
        .set({ lastSyncedAt: now, updatedAt: now })
        .where(eq(eventPlatforms.eventId, eventId))
        .run()
    })
    return { adapter, platform, remote, syncedAt: now }
  }

  async function discoverChallenges(eventId: string) {
    const inventory = await discoverInventory(eventId)
    const imported = new Map(
      db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.eventId, eventId),
            eq(challenges.remoteSourceKey, inventory.platform.sourceKey)
          )
        )
        .all()
        .flatMap((challenge) =>
          challenge.remoteId ? [[challenge.remoteId, challenge] as const] : []
        )
    )
    return {
      syncedAt: inventory.syncedAt,
      items: inventory.remote.map((remote) => ({
        ...remote,
        imported: imported.has(remote.id),
        localChallengeId: imported.get(remote.id)?.id ?? null,
      })),
    }
  }

  async function syncChallenges(
    eventId: string,
    remoteIds: string[],
    onResult?: (
      result: {
        remoteId: string
        status: "created" | "updated" | "failed"
        challengeId?: string
        error?: string
      },
      completed: number,
      total: number
    ) => void | Promise<void>
  ) {
    const inventory = await discoverInventory(eventId)
    const available = new Map(inventory.remote.map((item) => [item.id, item]))
    const results: Array<{
      remoteId: string
      status: "created" | "updated" | "failed"
      challengeId?: string
      error?: string
    }> = []
    const ids = [...new Set(remoteIds)]
    for (const remoteId of ids) {
      const summary = available.get(remoteId)
      let result: (typeof results)[number]
      if (!summary) {
        result = {
          remoteId,
          status: "failed",
          error: "Remote challenge is unavailable",
        }
      } else {
        try {
          const remote = await inventory.adapter.getChallenge(remoteId)
          const synced = await syncRemoteChallenge(
            eventId,
            inventory.platform.sourceKey,
            { ...remote, solved: remote.solved || summary.solved },
            inventory.adapter
          )
          result = {
            remoteId,
            challengeId: synced.id,
            status: synced.created ? "created" : "updated",
          }
        } catch (error) {
          result = {
            remoteId,
            status: "failed",
            error: syncFailureMessage(error),
          }
        }
      }
      results.push(result)
      await onResult?.(result, results.length, ids.length)
    }
    return { syncedAt: inventory.syncedAt, results }
  }

  return { discoverChallenges, syncChallenges }
}

function syncFailureMessage(error: unknown) {
  return error instanceof PlatformActionError || error instanceof PlatformError
    ? platformError(error).message
    : "Challenge could not be stored"
}
