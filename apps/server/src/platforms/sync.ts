import { basename } from "node:path"

import type {
  ChallengeSyncAttachment,
  ChallengeSyncItem,
  ChallengeSyncProgress,
} from "@aegisx/shared"
import { and, eq } from "drizzle-orm"

import type { Database } from "../db"
import {
  attachments,
  challengeRemote,
  challenges,
  eventPlatforms,
} from "../db/schema"
import type { createStorage } from "../infrastructure/storage"
import { getChallengeRemote, setSourceAvailability } from "./challenge-state"
import {
  type CtfPlatformAdapter,
  PlatformError,
  type RemoteAttachment,
  type RemoteChallenge,
  type RemoteChallengeListItem,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

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
    // Dedupe on (event, source, remote) — event-scoped since 0007: the same
    // platform challenge can be imported independently by multiple events.
    const existing = db
      .select()
      .from(challengeRemote)
      .where(
        and(
          eq(challengeRemote.eventId, eventId),
          eq(challengeRemote.sourceKey, sourceKey),
          eq(challengeRemote.remoteId, remote.id)
        )
      )
      .get()
    const id = existing?.challengeId ?? crypto.randomUUID()
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
      eventId,
      sourceKey,
      remoteId: remote.id,
      available: true,
      solved: existing?.solved === true || remote.solved,
      targetSupported: remote.targetSupported,
      targetIgnored: existing?.targetIgnored ?? false,
      targetCount: remote.targetCount,
      targetInfo: JSON.stringify(remote.targets),
      flagCount: remote.flagCount ?? null,
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
      // Atomic: a challenge row must never survive without its remote mapping
      // (the pre-0007 bug left orphan challenge rows when the mapping insert
      // hit the unique index).
      try {
        db.transaction((tx) => {
          tx.insert(challenges)
            .values({ id, ...challengeValues, createdAt: now })
            .run()
          tx.insert(challengeRemote)
            .values({ challengeId: id, ...remoteValues })
            .run()
        })
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE")) {
          throw new PlatformActionError(
            "invalid_state",
            `Challenge ${remote.name} (${remote.id}) is already imported by this event`
          )
        }
        throw error
      }
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
    let remote: RemoteChallengeListItem[]
    try {
      remote = await adapter.listChallenges()
    } catch (error) {
      throw platformError(error)
    }
    const now = new Date().toISOString()
    db.transaction((tx) => {
      // Event-scoped flip (0007) via the shared (eventId, sourceKey) writer:
      // only this event's rows — a shared source_key must never touch
      // another event's mappings (P0-2).
      setSourceAvailability(tx, eventId, platform.sourceKey, false)
      for (const item of remote) {
        tx.update(challengeRemote)
          .set({
            available: true,
            ...(item.solved ? { solved: true } : {}),
          })
          .where(
            and(
              eq(challengeRemote.eventId, eventId),
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
            // The detail payload may lack the category (dasctf exposes it only
            // on the list endpoint); the summary is the authoritative source.
            {
              ...remote,
              category: remote.category ?? summary.category,
              solved: remote.solved || summary.solved,
            },
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

  /** Re-fetch a single challenge's remote solved/available verdict and align
   * the local row to the platform's current truth. Uses the adapter's
   * `getSolveState` (each platform's most reliable per-challenge source —
   * ret2shell's submit endpoint, a1ctf's solved-challenge list, etc.) and
   * writes the verdict verbatim so a manual refresh can correct a stale local
   * flag. A 404 marks the challenge unavailable without clearing the verdict. */
  async function refreshChallengeRemote(challengeId: string) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    const platform = challenge ? storedPlatform(challenge.eventId) : undefined
    const adapter = challenge ? adapterForEvent(challenge.eventId) : undefined
    const remote = getChallengeRemote(db, challengeId)
    if (!challenge || !platform || !adapter || !remote) {
      throw new PlatformActionError(
        "not_bound",
        "Challenge is not connected to a platform"
      )
    }
    const now = new Date().toISOString()
    try {
      const solved = await adapter.getSolveState(remote.remoteId)
      db.update(challengeRemote)
        .set({ available: true, solved, syncedAt: now })
        .where(eq(challengeRemote.challengeId, challengeId))
        .run()
      return { found: true as const, available: true, solved }
    } catch (error) {
      if (error instanceof PlatformError && error.status === 404) {
        db.update(challengeRemote)
          .set({ available: false, syncedAt: now })
          .where(eq(challengeRemote.challengeId, challengeId))
          .run()
        return {
          found: false as const,
          available: false,
          solved: remote.solved,
        }
      }
      throw platformError(error)
    }
  }

  return { discoverChallenges, syncChallenges, refreshChallengeRemote }
}

function syncFailureMessage(error: unknown) {
  return error instanceof PlatformActionError || error instanceof PlatformError
    ? platformError(error).message
    : "Challenge could not be stored"
}
