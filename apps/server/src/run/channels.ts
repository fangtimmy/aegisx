import type { ChannelMessagePublic } from "@aegisx/shared"
import { asc, eq, gt, inArray } from "drizzle-orm"

import { agents, channelMessages, channelReads, challenges } from "../db/schema"
import {
  createChannelContext,
  dmKey,
  FLUSH_INTERVAL_MS,
  orchKey,
  parseChannelKey,
  SCHEDULER_READ_KEY,
  teamKey,
  type ChannelServiceDeps,
} from "./channels-context"
import { createDeliveryEngine } from "./channels-delivery"
import { createPostService } from "./channels-post"
import { createReadsService } from "./channels-reads"
import { systemClock } from "./clock"

export { renderMerged } from "./channels-render"

export {
  SCHEDULER_READ_KEY,
  dmKey,
  orchKey,
  parseChannelKey,
  teamKey,
  type ChannelServiceDeps,
} from "./channels-context"

export type ChannelService = ReturnType<typeof createChannelService>

/**
 * Derived-key channel core. A
 * channel is NOT a table row — it is a derived key:
 *
 *   #team          team:<challengeId>   same-challenge knowledge base shared
 *                                       by every agent on the challenge
 *   DM agent       dm:<agentId>         scheduler / user / system → one agent
 *   DM scheduler   orch:<eventId>       solver asks + system agent/queue
 *                                       events → the scheduler (stable
 *                                       "scheduler" read cursor across
 *                                       scheduler restarts). LEDGER ONLY —
 *                                       the scheduler reads it via the SDK;
 *                                       its wakes are decision points.
 *
 * The first message makes a channel exist; there is no directory table and
 * no get-or-create. Delivery is ONE policy for all three kinds:
 * post persists first (crash-safe), then urgent=true delivers immediately,
 * everything else rides the global flush tick (N=5min).
 *
 * v19 attachments: an agent post's `files` are paths relative to the
 * agent's OWN workspace directory; the server copies them into the
 * challenge workspace's shared/from-<agentId8>/ tree and records the
 * shared-relative path in the message meta. Readers reach the bytes
 * directly from their container (solvers: /workspace/shared/...; the
 * scheduler: /challenges/<cid>/workspace/shared/... read-only mount). User
 * uploads land in shared/upload-<epoch>/.
 *
 * Sections: channels-context (shared state + key/meta helpers),
 * channels-post (write path), channels-delivery (push engine + flush
 * tick), channels-reads (reads/listings), channels-render (pure delivery
 * rendering).
 */
export function createChannelService(deps: ChannelServiceDeps) {
  const intervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS
  const ctx = createChannelContext(deps, intervalMs, deps.clock ?? systemClock)
  const reads = createReadsService(ctx)
  const delivery = createDeliveryEngine(ctx)
  const writes = createPostService(
    ctx,
    delivery.deliverChannel,
    reads.resolveSelector
  )

  // --- explicit cleanup (no FK cascades — derived keys need sweeps) ----------

  /** Delete the messages + read cursors for the given channel keys. */
  function deleteChannelData(keys: string[]): void {
    if (keys.length === 0) return
    ctx.db
      .delete(channelMessages)
      .where(inArray(channelMessages.channelKey, keys))
      .run()
    ctx.db
      .delete(channelReads)
      .where(inArray(channelReads.channelKey, keys))
      .run()
  }

  /** Agent deletion: the agent's dm:<aid> data goes (its #team posts stay —
   * the knowledge base survives individual agents). */
  function cleanupAgentChannels(agentId: string): void {
    deleteChannelData([dmKey(agentId)])
  }

  /** Challenge deletion: the team:<cid> knowledge base. */
  function cleanupChallengeChannels(challengeId: string): void {
    deleteChannelData([teamKey(challengeId)])
  }

  /** Event deletion: orch + every team of the event's challenges + every dm
   * of the event's agents. MUST run before the event row delete cascades
   * the entities the key enumeration needs. */
  function cleanupEventChannels(eventId: string): void {
    const keys = [orchKey(eventId)]
    for (const challenge of ctx.db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()) {
      keys.push(teamKey(challenge.id))
    }
    for (const agent of ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.eventId, eventId))
      .all()) {
      keys.push(dmKey(agent.id))
    }
    deleteChannelData(keys)
  }

  function close(): void {
    delivery.stopFlushLoop()
  }

  /** Ledger rows after `after` (the SSE reconnect's Last-Event-ID), oldest
   * first, in the public wire shape. The replay source for the channel
   * face's stream resume: the ledger is durable, so a reconnecting client
   * re-reads exactly the rows its cursor skipped. */
  function replayAfter(after: number): ChannelMessagePublic[] {
    return ctx.db
      .select()
      .from(channelMessages)
      .where(gt(channelMessages.id, after))
      .orderBy(asc(channelMessages.id))
      .all()
      .map(ctx.toPublic)
  }

  delivery.startFlushLoop()

  return {
    // keys
    teamKey,
    dmKey,
    orchKey,
    parseChannelKey,
    // write paths
    post: writes.post,
    postWithUpload: writes.postWithUpload,
    // delivery engine
    deliver: delivery.deliver,
    deliverAgentAwaited: delivery.deliverAgentAwaited,
    deliverChannel: delivery.deliverChannel,
    runFlushTick: delivery.runFlushTick,
    // cursors
    readCursor: (key: string, readerKey: string) =>
      ctx.readCursor(key, readerKey),
    markRead: (key: string, readerKey: string, msgId: number) =>
      ctx.markRead(key, readerKey, msgId),
    // reads / listings
    listMessages: reads.listMessages,
    read: reads.read,
    readForAgent: reads.readForAgent,
    replayAfter,
    agentChannels: reads.agentChannels,
    challengeChannelTree: reads.challengeChannelTree,
    unreadCount: reads.unreadCount,
    channelInfo: reads.channelInfo,
    channelFileTarget: reads.channelFileTarget,
    // hold + inbox
    inboxSnapshot: (eventId: string) => {
      return {
        channelKey: orchKey(eventId),
        unreadCount: reads.unreadCount(orchKey(eventId), SCHEDULER_READ_KEY),
      }
    },
    // cleanup
    deleteChannelData,
    cleanupAgentChannels,
    cleanupChallengeChannels,
    cleanupEventChannels,
    // lifecycle
    close,
  }
}
