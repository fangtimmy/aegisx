import { and, eq, inArray, isNull, ne } from "drizzle-orm"

import type { Database } from "../../db"
import {
  challengeFlags,
  challengeRemote,
  challenges,
  queueState,
  spawnQueue,
} from "../../db/schema"
import type { DomainEventPayloads, DomainEventType } from "./registry"

/** The transaction-scoped handle the projector writes through (a drizzle
 * bun:sqlite transaction is structurally the db handle it came from). */
export type ProjectionDb = Pick<Database, "insert" | "update" | "delete">

/** One appended fact, handed to the projector inside the append transaction. */
export type AppendedEvent = {
  id: number
  type: DomainEventType
  eventId: string | null
  challengeId: string | null
  agentId: string | null
  payload: Record<string, unknown>
}

const now = () => new Date().toISOString()

/** Narrow an appended fact's payload to its registered type — the registry
 * validated the shape before the append; the caller pins the type with the
 * case's literal. */
function payloadOf<K extends DomainEventType>(
  type: K,
  payload: Record<string, unknown>
): DomainEventPayloads[K] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return payload as DomainEventPayloads[K]
}

/**
 * THE single writer of the projection tables (spawn_queue, queue_state,
 * challenge_flags, challenge_remote, the challenges control fields). Every
 * command emits its fact first; this switch performs the table write inside
 * the SAME transaction. Returns whether the projection actually changed a
 * row (guarded updates can legitimately miss).
 */
export function projectDomainEvent(
  tx: ProjectionDb,
  event: AppendedEvent
): boolean {
  switch (event.type) {
    // --- spawn_queue / queue_state ----------------------------------------

    case "queue.enqueued": {
      const p = payloadOf("queue.enqueued", event.payload)
      const ts = now()
      tx.insert(spawnQueue)
        .values({
          id: p.itemId,
          eventId: event.eventId!,
          ord: p.ord,
          challengeId: p.challengeId,
          params: JSON.stringify(p.params),
          timeoutMs: p.timeoutMs,
          prompt: p.prompt,
          source: p.source,
          status: "pending",
          agentId: null,
          error: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      return true
    }
    case "queue.launched": {
      const p = payloadOf("queue.launched", event.payload)
      return (
        tx
          .update(spawnQueue)
          .set({
            status: "running",
            agentId: p.agentId,
            error: null,
            updatedAt: now(),
          })
          .where(
            and(eq(spawnQueue.id, p.itemId), eq(spawnQueue.status, "pending"))
          )
          .returning({ id: spawnQueue.id })
          .get() !== undefined
      )
    }
    case "queue.item_failed": {
      const p = payloadOf("queue.item_failed", event.payload)
      tx.update(spawnQueue)
        .set({ status: "failed", error: p.error, updatedAt: now() })
        .where(eq(spawnQueue.id, p.itemId))
        .run()
      return true
    }
    case "queue.item_cancelled": {
      const p = payloadOf("queue.item_cancelled", event.payload)
      tx.update(spawnQueue)
        .set({ status: "cancelled", updatedAt: now() })
        .where(eq(spawnQueue.id, p.itemId))
        .run()
      return true
    }
    case "queue.item_done": {
      const p = payloadOf("queue.item_done", event.payload)
      return (
        tx
          .update(spawnQueue)
          .set({ status: "done", updatedAt: now() })
          .where(
            and(
              eq(spawnQueue.id, p.itemId),
              eq(spawnQueue.agentId, p.agentId),
              eq(spawnQueue.status, "running")
            )
          )
          .returning({ id: spawnQueue.id })
          .get() !== undefined
      )
    }
    case "queue.item_reset": {
      tx.update(spawnQueue)
        .set({ status: "pending", agentId: null, updatedAt: now() })
        .where(
          and(
            eq(spawnQueue.eventId, event.eventId!),
            eq(spawnQueue.status, "running")
          )
        )
        .run()
      return true
    }
    case "queue.reordered": {
      const p = payloadOf("queue.reordered", event.payload)
      const ts = now()
      p.itemIds.forEach((itemId, index) => {
        // Pending items only — running items keep their place.
        tx.update(spawnQueue)
          .set({ ord: index + 1, updatedAt: ts })
          .where(
            and(eq(spawnQueue.id, itemId), eq(spawnQueue.status, "pending"))
          )
          .run()
      })
      return true
    }
    case "queue.item_removed": {
      const p = payloadOf("queue.item_removed", event.payload)
      tx.delete(spawnQueue).where(eq(spawnQueue.id, p.itemId)).run()
      return true
    }
    case "queue.items_cleared": {
      tx.delete(spawnQueue)
        .where(
          and(
            eq(spawnQueue.eventId, event.eventId!),
            ne(spawnQueue.status, "running")
          )
        )
        .run()
      return true
    }
    case "queue.item_edited": {
      const p = payloadOf("queue.item_edited", event.payload)
      const set: Partial<typeof spawnQueue.$inferInsert> = { updatedAt: now() }
      if (p.prompt !== undefined) set.prompt = p.prompt
      if (p.timeoutMs !== undefined) set.timeoutMs = p.timeoutMs
      if (p.params !== undefined) set.params = JSON.stringify(p.params)
      tx.update(spawnQueue).set(set).where(eq(spawnQueue.id, p.itemId)).run()
      return true
    }
    case "queue.paused":
    case "queue.resumed": {
      const status = event.type === "queue.paused" ? "paused" : "running"
      const ts = now()
      tx.insert(queueState)
        .values({ eventId: event.eventId!, status, updatedAt: ts })
        .onConflictDoUpdate({
          target: queueState.eventId,
          set: { status, updatedAt: ts },
        })
        .run()
      return true
    }

    // --- challenge_flags / challenge_remote / challenges control fields ----

    case "flag.submitted": {
      const p = payloadOf("flag.submitted", event.payload)
      const ts = now()
      const patch = {
        status: p.status,
        source: "agent" as const,
        agentId: p.submitter,
        remoteId: p.remoteId ?? null,
        message: p.message ?? null,
        updatedAt: ts,
      }
      const updated = tx
        .update(challengeFlags)
        .set(patch)
        .where(eq(challengeFlags.id, p.flagId))
        .returning({ id: challengeFlags.id })
        .get()
      if (!updated) {
        tx.insert(challengeFlags)
          .values({
            id: p.flagId,
            challengeId: event.challengeId!,
            flag: p.value,
            createdAt: ts,
            ...patch,
          })
          .run()
      }
      return true
    }
    case "flag.accepted": {
      const p = payloadOf("flag.accepted", event.payload)
      const ts = now()
      const patch = {
        status: "accepted" as const,
        source: p.source,
        agentId: p.submitter,
        remoteId: p.remoteId ?? null,
        message: p.message ?? null,
        updatedAt: ts,
      }
      const updated = tx
        .update(challengeFlags)
        .set(patch)
        .where(eq(challengeFlags.id, p.flagId))
        .returning({ id: challengeFlags.id })
        .get()
      if (!updated) {
        tx.insert(challengeFlags)
          .values({
            id: p.flagId,
            challengeId: event.challengeId!,
            flag: p.value,
            createdAt: ts,
            ...patch,
          })
          .run()
      }
      if (p.remoteSolved) {
        tx.update(challengeRemote)
          .set({ solved: true })
          .where(eq(challengeRemote.challengeId, event.challengeId!))
          .run()
      }
      return true
    }
    case "flag.rejected": {
      const p = payloadOf("flag.rejected", event.payload)
      const ts = now()
      const patch = {
        status: "rejected" as const,
        source: "agent" as const,
        agentId: p.submitter,
        remoteId: p.remoteId ?? null,
        message: p.message ?? null,
        updatedAt: ts,
      }
      const updated = tx
        .update(challengeFlags)
        .set(patch)
        .where(eq(challengeFlags.id, p.flagId))
        .returning({ id: challengeFlags.id })
        .get()
      if (!updated) {
        tx.insert(challengeFlags)
          .values({
            id: p.flagId,
            challengeId: event.challengeId!,
            flag: p.value,
            createdAt: ts,
            ...patch,
          })
          .run()
      }
      return true
    }
    case "flag.deleted": {
      const p = payloadOf("flag.deleted", event.payload)
      tx.delete(challengeFlags).where(eq(challengeFlags.id, p.flagId)).run()
      return true
    }
    case "challenge.imported": {
      const p = payloadOf("challenge.imported", event.payload)
      const ts = now()
      // Atomic pair: a challenge row must never survive without its remote
      // mapping (the pre-0007 bug left orphan challenge rows).
      tx.insert(challenges)
        .values({
          id: p.challengeId,
          eventId: event.eventId!,
          name: p.name,
          description: p.description,
          category: p.category,
          points: p.points,
          ...(p.requiredFlags !== undefined
            ? { requiredFlags: p.requiredFlags }
            : {}),
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      tx.insert(challengeRemote)
        .values({
          challengeId: p.challengeId,
          eventId: event.eventId!,
          sourceKey: p.sourceKey,
          remoteId: p.remoteId,
          available: true,
          solved: p.solved,
          targetSupported: p.targetSupported,
          targetIgnored: false,
          targetCount: p.targetCount,
          targetInfo: p.targetInfo,
          syncedAt: ts,
        })
        .run()
      return true
    }
    case "challenge.synced": {
      const p = payloadOf("challenge.synced", event.payload)
      const challengeSet: Partial<typeof challenges.$inferInsert> = {}
      if (p.name !== undefined) challengeSet.name = p.name
      if (p.description !== undefined) challengeSet.description = p.description
      if (p.category !== undefined) challengeSet.category = p.category
      if (p.points !== undefined) challengeSet.points = p.points
      if (p.requiredFlags !== undefined) {
        challengeSet.requiredFlags = p.requiredFlags
      }
      if (Object.keys(challengeSet).length > 0) {
        challengeSet.updatedAt = now()
        tx.update(challenges)
          .set(challengeSet)
          .where(eq(challenges.id, p.challengeId))
          .run()
      }
      const remoteSet: Partial<typeof challengeRemote.$inferInsert> = {}
      if (p.available !== undefined) remoteSet.available = p.available
      if (p.solved !== undefined) remoteSet.solved = p.solved
      if (p.targetSupported !== undefined) {
        remoteSet.targetSupported = p.targetSupported
      }
      if (p.targetCount !== undefined) remoteSet.targetCount = p.targetCount
      if (p.targetInfo !== undefined) remoteSet.targetInfo = p.targetInfo
      if (p.targetIgnored !== undefined)
        remoteSet.targetIgnored = p.targetIgnored
      if (Object.keys(remoteSet).length > 0) {
        remoteSet.syncedAt = now()
        tx.update(challengeRemote)
          .set(remoteSet)
          .where(eq(challengeRemote.challengeId, p.challengeId))
          .run()
      }
      return true
    }
    case "challenge.overridden": {
      const p = payloadOf("challenge.overridden", event.payload)
      tx.update(challenges)
        .set({ manualSolveState: p.manualSolveState, updatedAt: now() })
        .where(eq(challenges.id, event.challengeId!))
        .run()
      return true
    }
    case "challenge.solved": {
      const p = payloadOf("challenge.solved", event.payload)
      // Guarded on solved_at IS NULL: the first-solve anchor is idempotent —
      // a solved → partial → solved loop never re-stamps (or re-emits here).
      return (
        tx
          .update(challenges)
          .set({ solvedAt: p.solvedAt })
          .where(
            and(
              eq(challenges.id, event.challengeId!),
              isNull(challenges.solvedAt)
            )
          )
          .returning({ id: challenges.id })
          .get() !== undefined
      )
    }
    case "challenge.progress_reset": {
      const p = payloadOf("challenge.progress_reset", event.payload)
      const ids = p.challengeIds ?? [event.challengeId!]
      tx.delete(challengeFlags)
        .where(inArray(challengeFlags.challengeId, ids))
        .run()
      tx.update(challenges)
        .set({ manualSolveState: "unsolved", solvedAt: null })
        .where(inArray(challenges.id, ids))
        .run()
      tx.update(challengeRemote)
        .set({ solved: false })
        .where(inArray(challengeRemote.challengeId, ids))
        .run()
      return true
    }

    // --- facts without a projection ----------------------------------------

    case "fence.blocked":
    case "channel.posted":
      return true
  }
  return true
}

/** The ONLY source-scoped availability writer's write half: a whole platform
 * source's mappings for ONE event flip together, always qualified by the
 * composite (eventId, sourceKey) — a single-key WHERE would silently hit
 * other events sharing the same source (P0-2). Callers own the surrounding
 * transaction when one exists. */
export function applySourceAvailability(
  db: ProjectionDb,
  eventId: string,
  sourceKey: string,
  available: boolean
): void {
  db.update(challengeRemote)
    .set({ available })
    .where(
      and(
        eq(challengeRemote.eventId, eventId),
        eq(challengeRemote.sourceKey, sourceKey)
      )
    )
    .run()
}

/** One inventory-sweep alignment: the listed remote challenge flips back to
 * available (the sweep set the whole source unavailable first). Part of the
 * discoverInventory transaction. */
export function applyInventoryAvailability(
  db: ProjectionDb,
  eventId: string,
  sourceKey: string,
  remoteId: string,
  solved: boolean
): void {
  db.update(challengeRemote)
    .set({
      available: true,
      ...(solved ? { solved: true } : {}),
    })
    .where(
      and(
        eq(challengeRemote.eventId, eventId),
        eq(challengeRemote.sourceKey, sourceKey),
        eq(challengeRemote.remoteId, remoteId)
      )
    )
    .run()
}

/** Import rollback: a new challenge's attachment sync failed, so the rows the
 * import provisioned go away (the failed command leaves no fact behind). */
export function rollbackChallengeImport(
  db: Database,
  challengeId: string
): void {
  db.delete(challenges).where(eq(challenges.id, challengeId)).run()
}
