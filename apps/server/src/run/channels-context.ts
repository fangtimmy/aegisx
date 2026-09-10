import { isRecord } from "@aegisx/shared"
import type {
  ChannelFileMeta,
  ChannelMessageMeta,
  ChannelMessagePublic,
} from "@aegisx/shared/channels"
import { and, eq, sql } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challenges, channelMessages, channelReads } from "../db/schema"
import type { Clock } from "./clock"
import { RunActionError } from "./errors"
import type { LiveBus } from "./host/live"

export type ChannelMessageRow = typeof channelMessages.$inferSelect

export type AgentRow = typeof agents.$inferSelect

/** Flush tick interval: non-urgent messages merge-deliver every N minutes.
 * Code constant; tests override via `flushIntervalMs`. */
export const FLUSH_INTERVAL_MS = 5 * 60_000

/** Stable read-cursor key for orch channels — the scheduler agent id churns
 * across restarts, the cursor must not. */
export const SCHEDULER_READ_KEY = "scheduler"

export function teamKey(challengeId: string): string {
  return `team:${challengeId}`
}

export function dmKey(agentId: string): string {
  return `dm:${agentId}`
}

export function orchKey(eventId: string): string {
  return `orch:${eventId}`
}

export type ParsedChannelKey = { kind: "team" | "dm" | "orch"; id: string }

export function parseChannelKey(key: string): ParsedChannelKey | undefined {
  const idx = key.indexOf(":")
  if (idx <= 0) return undefined
  const kind = key.slice(0, idx)
  const id = key.slice(idx + 1)
  if (!id) return undefined
  if (kind === "team" || kind === "dm" || kind === "orch") {
    return { kind, id }
  }
  return undefined
}

export type MessageAuthor =
  | { type: "system"; name?: string }
  | { type: "user"; name?: string }
  | { type: "agent"; agentId: string; name?: string }

export type PostInput = {
  channelKey: string
  author: MessageAuthor
  body: string
  /** urgent=true → immediate deliverChannel; otherwise the flush tick
   * merges it. Defaults per writer are the CALLER's business. */
  urgent?: boolean
  meta?: ChannelMessageMeta
  /** Paths relative to the POSTING agent's own workspace dir
   * (agents/<id8>/...) — the server copies them into shared/from-<id8>/. */
  files?: string[]
  /** Push mode for deliveries triggered by this post (default "steer"). */
  deliverAs?: "steer" | "followUp"
}

export type AttachmentInput = {
  filename: string
  /** File bytes (user multipart upload path). */
  stream: () => Promise<Uint8Array>
  size: number
}

export type ChannelServiceDeps = {
  db: Database
  dataDir: string
  bus: LiveBus
  /** Deliver a message to the agent through its runtime (steer / followUp
   * while streaming, fresh turn otherwise, cold resume when session-less).
   * Late-bound: the service constructs channels before any runtime exists,
   * so this is only invoked after both exist. */
  send(
    agentId: string,
    text: string,
    deliverAs?: "steer" | "followUp",
    opts?: { assertLive?: (id: string) => boolean }
  ): Promise<boolean>
  now(): string
  /** Host root of a challenge's workspace tree (attachment copy target). */
  challengeWorkspaceRoot(eventId: string, challengeId: string): string
  /** Renders the fleet snapshot appended to every scheduler (orch)
   * delivery; return "" to skip. Wired by the run service (owns the
   * fleet/scheduler domain); absent in tests. */
  renderSchedulerDigest?(eventId: string): string
  /** Test seam: flush tick interval. */
  flushIntervalMs?: number
  /** Time layer (default: the system clock). The flush tick reads time and
   * schedules itself through it; tests inject a fake clock. */
  clock?: Clock
}

/** Server-stamped meta for stored messages: agent posts always carry
 * their agent id (spoof-proof attribution; callers may not override it)
 * and urgent=true collapses to a single flag. */
export function serverMeta(
  author: { type: "system" | "user" | "agent"; agentId?: string },
  meta: ChannelMessageMeta | undefined,
  urgent: boolean
): ChannelMessageMeta & { files?: ChannelFileMeta[] } {
  const stamped: ChannelMessageMeta & { files?: ChannelFileMeta[] } = {
    ...meta,
  }
  if (urgent) stamped.urgent = true
  else delete stamped.urgent
  if (author.type === "agent" && author.agentId) {
    stamped.agentId = author.agentId
  }
  return stamped
}

/** Defensive meta parse: keep only the known typed keys. */
export function parseMeta(
  raw: string
): ChannelMessageMeta & { files?: ChannelFileMeta[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) {
    return {}
  }
  const src = parsed
  const meta: ChannelMessageMeta & { files?: ChannelFileMeta[] } = {}
  if (src.urgent === true) meta.urgent = true
  if (typeof src.agentId === "string") meta.agentId = src.agentId
  if (src.source === "manual" || src.source === "scheduler") {
    meta.source = src.source
  }
  if (typeof src.eventType === "string") meta.eventType = src.eventType
  if (src.noticeType === "notice" || src.noticeType === "emergency") {
    meta.noticeType = src.noticeType
  }
  if (Array.isArray(src.tags)) {
    const tags = src.tags.filter((t): t is string => typeof t === "string")
    if (tags.length) meta.tags = tags
  }
  if (Array.isArray(src.files)) {
    const files = src.files.flatMap((f) => {
      if (!isRecord(f)) return []
      const file = f
      if (
        typeof file.path !== "string" ||
        typeof file.filename !== "string" ||
        typeof file.size !== "number"
      ) {
        return []
      }
      return [{ path: file.path, filename: file.filename, size: file.size }]
    })
    if (files.length) meta.files = files
  }
  return meta
}

export function isUrgent(row: ChannelMessageRow): boolean {
  try {
    return JSON.parse(row.meta)?.urgent === true
  } catch {
    return false
  }
}

/** Shared channel state: entity lookups, read cursors, SSE fan-out, and the
 * per-event delivery hold. The section modules (post / delivery / reads)
 * close over one context instead of one 1500-line factory closure. */
export function createChannelContext(
  deps: ChannelServiceDeps,
  intervalMs: number,
  clock: Clock
) {
  const { db, dataDir, bus } = deps

  // --- entity lookups -----------------------------------------------------------

  function agentRow(agentId: string): typeof agents.$inferSelect | undefined {
    return db.select().from(agents).where(eq(agents.id, agentId)).get()
  }

  function challengeRow(
    challengeId: string
  ): typeof challenges.$inferSelect | undefined {
    return db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
  }

  /** The event's scheduler agent row (at most one per event). */
  function schedulerAgentRow(eventId: string) {
    return db
      .select()
      .from(agents)
      .where(and(eq(agents.eventId, eventId), eq(agents.role, "orchestrator")))
      .get()
  }

  function channelLabel(key: ParsedChannelKey): string {
    if (key.kind === "team") return "#team"
    if (key.kind === "orch") return "#orch"
    const target = agentRow(key.id)
    return `DM ${target?.name ?? "agent"}`
  }

  function eventOfKey(parsed: ParsedChannelKey): string {
    if (parsed.kind === "orch") return parsed.id
    if (parsed.kind === "team") {
      return challengeRow(parsed.id)?.eventId ?? ""
    }
    return agentRow(parsed.id)?.eventId ?? ""
  }

  function requireKey(raw: string): ParsedChannelKey & { raw: string } {
    const parsed = parseChannelKey(raw)
    if (!parsed) {
      throw new RunActionError("invalid", `非法频道键：${raw}`)
    }
    return { ...parsed, raw }
  }

  // --- read cursors (已读 = 投递状态) ---------------------------------------

  function readCursor(channelKey: string, readerKey: string): number {
    const row = db
      .select({ lastReadMsgId: channelReads.lastReadMsgId })
      .from(channelReads)
      .where(
        and(
          eq(channelReads.channelKey, channelKey),
          eq(channelReads.readerKey, readerKey)
        )
      )
      .get()
    return row?.lastReadMsgId ?? 0
  }

  /** The single cursor-advance point (takes max). The three progression
   * points — deliverAgent after injection, SDK read (pull = consume), and an
   * agent's own post — all funnel here. */
  function markRead(
    channelKey: string,
    readerKey: string,
    msgId: number
  ): void {
    const ts = deps.now()
    db.insert(channelReads)
      .values({
        channelKey,
        readerKey,
        lastReadMsgId: msgId,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [channelReads.channelKey, channelReads.readerKey],
        set: {
          lastReadMsgId: sql`max(${channelReads.lastReadMsgId}, ${msgId})`,
          updatedAt: ts,
        },
      })
      .run()
  }

  // --- message rows ---------------------------------------------------

  function toPublic(row: ChannelMessageRow): ChannelMessagePublic {
    const meta = parseMeta(row.meta)
    return {
      id: row.id,
      channelKey: row.channelKey,
      authorType: row.authorType,
      authorAgentId: row.authorAgentId,
      authorName: row.authorName,
      body: row.body,
      meta,
      createdAt: row.createdAt,
      files: meta.files ?? [],
    }
  }

  // --- SSE fan-out ----------------------------------------------------------

  /** SSE split: dm → the target agent's channel; orch → the event's channel;
   * team → the event's channel AND the challenge's channel (the challenge IM
   * view). */
  function emitChannelMessage(
    parsed: ParsedChannelKey,
    message: ChannelMessagePublic
  ): void {
    for (const channel of emitChannelsOf(parsed)) {
      bus.emit(channel, { type: "channel.message", message })
    }
  }

  function emitChannelsOf(parsed: ParsedChannelKey): string[] {
    if (parsed.kind === "dm") return [parsed.id]
    if (parsed.kind === "orch") return [parsed.id]
    // team: the event channel + the challenge channel (the challenge IM).
    const eventId = challengeRow(parsed.id)?.eventId
    return eventId ? [eventId, parsed.id] : [parsed.id]
  }

  // --- hold (deliveryPaused, per event) --------------------------------

  /** Paused events: the tick AND urgent deliveries skip them entirely (posts
   * only store); the next tick/urgent after resume catches up. In-memory
   * only (a service restart resets it). */
  const deliveryPausedEvents = new Set<string>()

  return {
    db,
    dataDir,
    bus,
    deps,
    clock,
    intervalMs,
    agentRow,
    challengeRow,
    schedulerAgentRow,
    channelLabel,
    eventOfKey,
    requireKey,
    readCursor,
    markRead,
    toPublic,
    emitChannelMessage,
    emitChannelsOf,
    setDeliveryPaused(eventId: string, paused: boolean): void {
      if (paused) deliveryPausedEvents.add(eventId)
      else deliveryPausedEvents.delete(eventId)
    },
    isDeliveryPaused(eventId: string): boolean {
      return deliveryPausedEvents.has(eventId)
    },
    clearDeliveryPaused(): void {
      deliveryPausedEvents.clear()
    },
  }
}

export type ChannelContext = ReturnType<typeof createChannelContext>
