import { basename } from "node:path"
import type {
  ChallengeSyncAttachment,
  ChallengeSyncItem,
  ChallengeSyncProgress,
} from "@aegisx/shared"
import { and, eq } from "drizzle-orm"
import type { createDatabase } from "../db"
import {
  attachments,
  challengeRemote,
  challenges,
  eventPlatforms,
} from "../db/schema"
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
  ): Promise<ChallengeSyncAttachment> {
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
    const originalName = basename(remote.filename) || "attachment"
    const values = {
      challengeId,
      originalName,
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
    return {
      filename: originalName,
      size: metadata.size,
      status: existing ? "updated" : "downloaded",
    }
  }

  async function syncRemoteChallenge(
    eventId: string,
    sourceKey: string,
    remote: RemoteChallenge,
    adapter: CtfPlatformAdapter,
    onProgress?: (progress: ChallengeSyncProgress) => void | Promise<void>
  ) {
    const existing = db
      .select({
        challenge: challenges,
        remote: challengeRemote,
      })
      .from(challenges)
      .innerJoin(
        challengeRemote,
        eq(challenges.id, challengeRemote.challengeId)
      )
      .where(
        and(
          eq(challenges.eventId, eventId),
          eq(challengeRemote.sourceKey, sourceKey),
          eq(challengeRemote.remoteId, remote.id)
        )
      )
      .get()
    const id = existing?.challenge.id ?? crypto.randomUUID()
    const now = new Date().toISOString()
    const challengeValues = {
      eventId,
      name: remote.name,
      description: remote.description || "No challenge description provided.",
      category: remote.category,
      points: remote.points,
      updatedAt: now,
    }
    const remoteValues = {
      sourceKey,
      remoteId: remote.id,
      available: true,
      solved: existing?.remote.solved === true || remote.solved,
      targetSupported: remote.targetSupported,
      targetIgnored: existing?.remote.targetIgnored ?? false,
      targetCount: remote.targetCount,
      targetInfo: JSON.stringify(remote.targets),
      syncedAt: now,
    }
    await onProgress?.({
      remoteId: remote.id,
      phase: "metadata",
      message: existing
        ? `Updating challenge metadata`
        : `Creating challenge metadata`,
      name: remote.name,
      category: remote.category,
      points: remote.points,
    })
    if (existing) {
      db.update(challenges)
        .set(challengeValues)
        .where(eq(challenges.id, id))
        .run()
      db.update(challengeRemote)
        .set(remoteValues)
        .where(eq(challengeRemote.challengeId, id))
        .run()
    } else {
      db.insert(challenges)
        .values({ id, ...challengeValues, createdAt: now })
        .run()
      db.insert(challengeRemote)
        .values({ challengeId: id, ...remoteValues })
        .run()
    }

    const syncedAttachments: ChallengeSyncAttachment[] = []
    try {
      const total = remote.attachments.length
      for (const [index, attachment] of remote.attachments.entries()) {
        const filename = basename(attachment.filename) || "attachment"
        await onProgress?.({
          remoteId: remote.id,
          phase: "attachment",
          message: `Downloading attachment ${index + 1}/${total}: ${filename}`,
          name: remote.name,
          category: remote.category,
          points: remote.points,
          attachment: { filename, index: index + 1, total },
        })
        syncedAttachments.push(
          await syncAttachment(eventId, id, attachment, adapter)
        )
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
    return {
      id,
      created: !existing,
      name: remote.name,
      category: remote.category,
      points: remote.points,
      attachments: syncedAttachments,
    }
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
      tx.update(challengeRemote)
        .set({ available: false })
        .where(eq(challengeRemote.sourceKey, platform.sourceKey))
        .run()
      for (const item of remote) {
        tx.update(challengeRemote)
          .set({
            available: true,
            ...(item.solved ? { solved: true } : {}),
          })
          .where(
            and(
              eq(challengeRemote.sourceKey, platform.sourceKey),
              eq(challengeRemote.remoteId, item.id)
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
        .select({
          remoteId: challengeRemote.remoteId,
          challengeId: challenges.id,
        })
        .from(challenges)
        .innerJoin(
          challengeRemote,
          eq(challenges.id, challengeRemote.challengeId)
        )
        .where(
          and(
            eq(challenges.eventId, eventId),
            eq(challengeRemote.sourceKey, inventory.platform.sourceKey)
          )
        )
        .all()
        .map(({ remoteId, challengeId }) => [remoteId, challengeId] as const)
    )
    return {
      syncedAt: inventory.syncedAt,
      items: inventory.remote.map((remote) => ({
        ...remote,
        imported: imported.has(remote.id),
        localChallengeId: imported.get(remote.id) ?? null,
      })),
    }
  }

  async function syncChallenges(
    eventId: string,
    remoteIds: string[],
    onEvent?: (
      event:
        | { type: "progress"; progress: ChallengeSyncProgress }
        | {
            type: "item"
            item: ChallengeSyncItem
            completed: number
            total: number
          }
    ) => void | Promise<void>
  ) {
    const inventory = await discoverInventory(eventId)
    const available = new Map(inventory.remote.map((item) => [item.id, item]))
    const results: ChallengeSyncItem[] = []
    const ids = [...new Set(remoteIds)]
    for (const remoteId of ids) {
      const summary = available.get(remoteId)
      let result: ChallengeSyncItem
      if (!summary) {
        result = {
          remoteId,
          status: "failed",
          error: "Remote challenge is unavailable",
        }
      } else {
        await onEvent?.({
          type: "progress",
          progress: {
            remoteId,
            phase: "fetching",
            message: `Fetching challenge details`,
            name: summary.name,
            category: summary.category,
            points: summary.points,
          },
        })
        try {
          const remote = await inventory.adapter.getChallenge(remoteId)
          const synced = await syncRemoteChallenge(
            eventId,
            inventory.platform.sourceKey,
            { ...remote, solved: remote.solved || summary.solved },
            inventory.adapter,
            async (progress) => {
              await onEvent?.({ type: "progress", progress })
            }
          )
          result = {
            remoteId,
            challengeId: synced.id,
            status: synced.created ? "created" : "updated",
            name: synced.name,
            category: synced.category,
            points: synced.points,
            attachments: synced.attachments,
          }
        } catch (error) {
          result = {
            remoteId,
            status: "failed",
            error: syncFailureMessage(error),
            name: summary.name,
            category: summary.category,
            points: summary.points,
          }
        }
      }
      results.push(result)
      await onEvent?.({
        type: "item",
        item: result,
        completed: results.length,
        total: ids.length,
      })
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
