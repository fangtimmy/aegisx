import {
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm"

import type { SessionLifecycle } from "../agents/lifecycle"
import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import {
  agents,
  channelFiles,
  channelMessages,
  channelReads,
  channels,
  runs,
} from "../db/schema"
import { RunActionError } from "./errors"
import type { RunQueries } from "./queries"

/**
 * Unified message layer core (docs/im-channels.md). One channel tree per
 * run (challenge-scope #team/#announce + DM per solver) + one event-scope
 * channel (DM: scheduler). v17 (§11): #team/#announce are CHALLENGE-scoped —
 * they persist across runs of the same challenge, so a retry run's fresh
 * solvers mechanically see every prior finding/dead-end/announcement (the
 * onboarding deliver sweeps it into their first turn). Messages are written
 * once, stored once, rendered once — delivery (whether/when to wake whom) is
 * a per-channel POLICY implemented here, not a per-call-site decision.
 *
 * Delivery = steer via `lifecycle.send(agentId, text, "steer")` (three-state
 * semantics owned by the lifecycle: streaming → inject at turn end, idle →
 * fresh turn, closed → onResume cold-restore). Red lines honored:
 *  - #team / #announce only store for agents on a closed run (restore touches
 *    only the triggered agent); DMs may cold-wake their target.
 *  - Steer text carries 📎 filename/size metadata lines only — attachment
 *    CONTENT is never injected (agents materialize via SDK fetch).
 *  - Attachment sources are resolve-checked inside the posting agent's run
 *    workspace (no escape).
 */

/** Server-side message body cap (characters). */
export const MAX_MESSAGE_CHARS = 16_000
/** Per-file attachment cap. */
const MAX_FILE_BYTES = 64 * 1024 * 1024
/** Per-message attachment caps. */
const MAX_FILES_PER_MESSAGE = 8
const MAX_MESSAGE_TOTAL_BYTES = 128 * 1024 * 1024
/** Deliver merged-text cap (characters); overflow folds to a catch-up line. */
const MAX_DELIVER_CHARS = 8_000
/** Default page size for timeline reads. */
export const DEFAULT_PAGE = 50

/** Stable read-cursor key for the event-scope scheduler DM — the scheduler
 * agent id churns across restarts, the cursor must not. */
const SCHEDULER_READ_KEY = "scheduler"

export type ChannelRow = typeof channels.$inferSelect
export type ChannelMessageRow = typeof channelMessages.$inferSelect
export type ChannelFileRow = typeof channelFiles.$inferSelect

export type MessageAuthor =
  | { type: "system"; name?: string }
  | { type: "user"; name?: string }
  | { type: "agent"; agentId: string; name?: string }

export type PostInput = {
  channelId: string
  author: MessageAuthor
  body: string
  meta?: Record<string, unknown>
  /** Workspace-relative paths copied out of the POSTING agent's run
   * workspace (snapshot semantics, §2.5). */
  files?: string[]
  /** Delivery-time skip (partial-flag steer parity: the submitter is not
   * re-steered). Only applies to challenge-scope group channels. */
  skipAgentIds?: string[]
  /** Push mode for deliveries triggered by this post (default "steer").
   * The scheduler tools' message_run/message_agent use "followUp". */
  deliverAs?: "steer" | "followUp"
  /** Suppress the automatic fire-and-forget delivery; the caller delivers
   * itself (awaited) via deliverAwaited — the user-facing send wrappers'
   * contract (cold-restore must complete before the call returns). */
  deferDelivery?: boolean
}

export type AttachmentInput = {
  filename: string
  /** File bytes (user multipart upload path). */
  stream: () => Promise<Uint8Array>
  size: number
}

/** Public message shape (timeline + SDK read). */
export type ChannelMessagePublic = {
  id: number
  channelId: string
  kind: "text" | "recap"
  authorType: "system" | "user" | "agent"
  authorAgentId: string | null
  authorName: string
  body: string
  meta: Record<string, unknown>
  createdAt: string
  files: Array<{ id: string; filename: string; size: number }>
}

export type ChannelPublic = {
  id: string
  scopeType: "run" | "event" | "challenge"
  runId: string | null
  eventId: string
  /** Challenge scope (#team/#announce, v17): the owning challenge. */
  challengeId: string | null
  kind: "team" | "announce" | "dm"
  targetAgentId: string | null
  /** Display label: "#team" / "#announce" / "DM <agentName>". */
  label: string
  unread: number
  lastMessageAt: string | null
  /** Challenge-scope channels only (v17 §11.5): how many live runs currently
   * share this channel — the UI's 共享 badge. Null for DM/scheduler DM. */
  sharedRunCount: number | null
}

export type ChannelServiceDeps = {
  db: Database
  dataDir: string
  bus: LiveBus
  queries: RunQueries
  lifecycle: SessionLifecycle
  now(): string
  /** Absolute host workspace path for a run (attachment source / validation). */
  workspaceAbs(runId: string): string
  /** New message landed in an event-scope scheduler DM → the digest policy
   * (scheduler-digest.ts) decides flushing. No live scheduler → no-op (the
   * message stays stored). */
  onSchedulerDmMessage(eventId: string, message: ChannelMessagePublic): void
}

export type ChannelService = ReturnType<typeof createChannelService>

export function createChannelService(deps: ChannelServiceDeps) {
  const { db, dataDir, bus, queries, lifecycle } = deps

  // --- channel tree ---------------------------------------------------------

  function channelById(channelId: string): ChannelRow | undefined {
    return db.select().from(channels).where(eq(channels.id, channelId)).get()
  }

  function requireChannel(channelId: string): ChannelRow {
    const row = channelById(channelId)
    if (!row) throw new RunActionError("not_found", "Channel not found")
    return row
  }

  /** Run channels (v17): the challenge's #team + #announce (resolved via the
   * run's challengeId — shared across every run of that challenge) + the
   * run's own DM channels, canonical order. */
  function runChannels(runId: string): ChannelRow[] {
    const row = queries.getRow(runId)
    if (!row) return []
    const groups = row.challengeId
      ? db
          .select()
          .from(channels)
          .where(
            and(
              eq(channels.challengeId, row.challengeId),
              inArray(channels.kind, ["team", "announce"])
            )
          )
          .all()
      : []
    const dms = db
      .select()
      .from(channels)
      .where(and(eq(channels.runId, runId), eq(channels.kind, "dm")))
      .all()
    const rank = (kind: string) =>
      kind === "announce" ? 0 : kind === "team" ? 1 : 2
    return [...groups, ...dms].sort(
      (a, b) =>
        rank(a.kind) - rank(b.kind) || a.createdAt.localeCompare(b.createdAt)
    )
  }

  /** The event's scheduler DM channel (event-scope, persistent). */
  function schedulerDm(eventId: string): ChannelRow | undefined {
    return db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.eventId, eventId),
          eq(channels.scopeType, "event"),
          eq(channels.kind, "dm")
        )
      )
      .get()
  }

  function insertChannel(input: {
    scopeType: "run" | "event" | "challenge"
    runId: string | null
    eventId: string
    challengeId?: string | null
    kind: "team" | "announce" | "dm"
    targetAgentId: string | null
  }): ChannelRow {
    const row: typeof channels.$inferInsert = {
      id: crypto.randomUUID(),
      scopeType: input.scopeType,
      runId: input.runId,
      eventId: input.eventId,
      challengeId: input.challengeId ?? null,
      kind: input.kind,
      targetAgentId: input.targetAgentId,
      createdAt: deps.now(),
    }
    db.insert(channels).values(row).run()
    return row as ChannelRow
  }

  /** Idempotent (v17 §11.2): get-or-create the CHALLENGE's #team +
   * #announce. The first run on a challenge creates them; every later run
   * reuses the same channels (and their history). DMs are per-run and created
   * per agent (ensureAgentDm). */
  function ensureChallengeChannels(runId: string): void {
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    if (!row.challengeId) return // event-scope scheduler run: no group channels
    for (const kind of ["team", "announce"] as const) {
      const existing = db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.challengeId, row.challengeId),
            eq(channels.kind, kind)
          )
        )
        .get()
      if (!existing) {
        insertChannel({
          scopeType: "challenge",
          runId: null,
          eventId: row.eventId,
          challengeId: row.challengeId,
          kind,
          targetAgentId: null,
        })
      }
    }
  }

  /** The challenge's group channel of a kind (v17: the single #team/#announce
   * of the challenge — the fan-out target for system notifications). */
  function challengeChannel(
    challengeId: string,
    kind: "team" | "announce"
  ): ChannelRow | undefined {
    return db
      .select()
      .from(channels)
      .where(
        and(eq(channels.challengeId, challengeId), eq(channels.kind, kind))
      )
      .get()
  }

  /** Idempotent: ensure the agent's DM channel exists (create + add_agent +
   * legacy-run backfill on first message). */
  function ensureAgentDm(runId: string, agentId: string): ChannelRow {
    const existing = db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.runId, runId),
          eq(channels.kind, "dm"),
          eq(channels.targetAgentId, agentId)
        )
      )
      .get()
    if (existing) return existing
    const row = queries.getRow(runId)
    if (!row) throw new RunActionError("not_found", "Run not found")
    return insertChannel({
      scopeType: "run",
      runId,
      eventId: row.eventId,
      kind: "dm",
      targetAgentId: agentId,
    })
  }

  /** Idempotent: ensure the event's scheduler DM exists; re-stamps the target
   * agent pointer on each scheduler start (the channel + history persist). */
  function ensureSchedulerDm(
    eventId: string,
    schedulerAgentId: string
  ): ChannelRow {
    const existing = schedulerDm(eventId)
    if (!existing) {
      return insertChannel({
        scopeType: "event",
        runId: null,
        eventId,
        kind: "dm",
        targetAgentId: schedulerAgentId,
      })
    }
    if (existing.targetAgentId !== schedulerAgentId) {
      db.update(channels)
        .set({ targetAgentId: schedulerAgentId })
        .where(eq(channels.id, existing.id))
        .run()
    }
    return existing
  }

  function agentRow(agentId: string): typeof agents.$inferSelect | undefined {
    return db.select().from(agents).where(eq(agents.id, agentId)).get()
  }

  function channelLabel(channel: ChannelRow): string {
    if (channel.kind === "team") return "#team"
    if (channel.kind === "announce") return "#announce"
    const target = channel.targetAgentId
      ? agentRow(channel.targetAgentId)
      : undefined
    return `DM ${target?.name ?? target?.slot ?? "agent"}`
  }

  // --- read cursors ----------------------------------------------------------

  function readCursor(channelId: string, agentId: string): number {
    const row = db
      .select({ lastReadMsgId: channelReads.lastReadMsgId })
      .from(channelReads)
      .where(
        and(
          eq(channelReads.channelId, channelId),
          eq(channelReads.agentId, agentId)
        )
      )
      .get()
    return row?.lastReadMsgId ?? 0
  }

  function cursorFor(channel: ChannelRow, agentId: string): number {
    return readCursor(channel.id, agentId)
  }

  function advanceCursor(
    channel: ChannelRow,
    agentId: string,
    msgId: number
  ): void {
    advanceCursorKey(channel.id, agentId, msgId)
  }

  /** Explicit stable-key advance for the event-scope scheduler DM (digest
   * flush recap cursor; the scheduler agent id churns, the key must not). */
  function advanceSchedulerCursor(channel: ChannelRow, msgId: number): void {
    advanceCursorKey(channel.id, SCHEDULER_READ_KEY, msgId)
  }

  function advanceCursorKey(
    channelId: string,
    key: string,
    msgId: number
  ): void {
    const ts = deps.now()
    db.insert(channelReads)
      .values({
        channelId,
        agentId: key,
        lastReadMsgId: msgId,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [channelReads.channelId, channelReads.agentId],
        set: {
          lastReadMsgId: sql`max(${channelReads.lastReadMsgId}, ${msgId})`,
          updatedAt: ts,
        },
      })
      .run()
  }

  // --- messages + attachments -------------------------------------------------

  function filesDir(channelId: string, messageId: number): string {
    return join(dataDir, "channel-files", channelId, String(messageId))
  }

  function messageFiles(messageId: number): ChannelFileRow[] {
    return db
      .select()
      .from(channelFiles)
      .where(eq(channelFiles.messageId, messageId))
      .orderBy(asc(channelFiles.createdAt), asc(channelFiles.id))
      .all()
  }

  function toPublic(row: ChannelMessageRow): ChannelMessagePublic {
    let meta: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.meta)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch {
      // leave {}
    }
    return {
      id: row.id,
      channelId: row.channelId,
      kind: row.kind as "text" | "recap",
      authorType: row.authorType as "system" | "user" | "agent",
      authorAgentId: row.authorAgentId,
      authorName: row.authorName,
      body: row.body,
      meta,
      createdAt: row.createdAt,
      files: messageFiles(row.id).map((file) => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
      })),
    }
  }

  /** Resolve a workspace-relative attachment source path against the posting
   * agent's run workspace; reject anything that escapes it. Returns the
   * absolute host path + the sanitized filename. */
  function resolveWorkspaceFile(
    runId: string,
    agentId: string,
    path: string
  ): { abs: string; filename: string } {
    if (!path || path.includes("\0") || path.startsWith("/")) {
      throw new RunActionError(
        "invalid",
        `附件路径不合法：${path}（须为 workspace 内的相对路径）`
      )
    }
    const root = resolve(deps.workspaceAbs(runId))
    const candidate = resolve(root, path)
    const rel = relative(root, candidate)
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
      throw new RunActionError(
        "invalid",
        `附件路径越界：${path}（须位于本 run workspace 内）`
      )
    }
    let stats
    try {
      stats = statSync(candidate)
    } catch {
      throw new RunActionError("not_found", `附件不存在：${path}`)
    }
    if (!stats.isFile()) {
      throw new RunActionError("invalid", `附件不是文件：${path}`)
    }
    if (stats.size > MAX_FILE_BYTES) {
      throw new RunActionError(
        "invalid",
        `附件超过单文件上限 64MB：${path}（${formatSize(stats.size)}）`
      )
    }
    return { abs: candidate, filename: basename(candidate) }
  }

  /** Server-stamped meta for stored messages: agent posts always carry
   * their run id (digest run attribution + spoof-proof; callers may not
   * override it). */
  function serverMeta(
    author: { type: "system" | "user" | "agent"; agentId?: string },
    meta: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    if (author.type !== "agent" || !author.agentId) return meta ?? {}
    const agent = agentRow(author.agentId)
    return { ...meta, runId: agent?.runId ?? null }
  }

  /** Post one message (the single write path). Persists the row + snapshot
   * attachments, advances the author's own cursor, broadcasts SSE, and
   * triggers the channel's delivery policy. */
  function post(input: PostInput): ChannelMessagePublic {
    const channel = requireChannel(input.channelId)
    const body = input.body ?? ""
    if (body.length > MAX_MESSAGE_CHARS) {
      throw new RunActionError(
        "invalid",
        `消息超过 ${MAX_MESSAGE_CHARS} 字符上限（当前 ${body.length}）`
      )
    }
    // Author resolution + write permission (light, see design §四 gate note).
    const author = resolveAuthor(channel, input.author)

    // Attachment sources resolved BEFORE the row insert (escape check).
    if ((input.files?.length ?? 0) > MAX_FILES_PER_MESSAGE) {
      throw new RunActionError(
        "invalid",
        `单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`
      )
    }
    const sources: Array<{ abs: string; filename: string; size: number }> = []
    if (input.files?.length) {
      if (author.type !== "agent") {
        throw new RunActionError(
          "invalid",
          "workspace 附件只能由 agent 发送（用户走 multipart 上传）"
        )
      }
      const agent = agentRow(author.agentId)!
      for (const path of input.files) {
        const resolved = resolveWorkspaceFile(agent.runId, agent.id, path)
        sources.push({
          abs: resolved.abs,
          filename: resolved.filename,
          size: statSync(resolved.abs).size,
        })
      }
      const total = sources.reduce((sum, file) => sum + file.size, 0)
      if (total > MAX_MESSAGE_TOTAL_BYTES) {
        throw new RunActionError(
          "invalid",
          `单条消息附件总量超过 128MB 上限（${formatSize(total)}）`
        )
      }
    }

    const ts = deps.now()
    const inserted = db
      .insert(channelMessages)
      .values({
        channelId: channel.id,
        kind: "text",
        authorType: author.type,
        authorAgentId: author.type === "agent" ? author.agentId : null,
        authorName: author.name,
        body,
        meta: JSON.stringify(serverMeta(author, input.meta)),
        createdAt: ts,
      })
      .returning()
      .get()
    const message = toPublic(inserted)

    // Snapshot-copy attachments (post-time freeze, §2.5).
    if (sources.length > 0) {
      const dir = filesDir(channel.id, message.id)
      mkdirSync(dir, { recursive: true })
      for (const source of sources) {
        copyFileSync(source.abs, join(dir, source.filename))
        db.insert(channelFiles)
          .values({
            id: crypto.randomUUID(),
            messageId: message.id,
            channelId: channel.id,
            filename: source.filename,
            size: source.size,
            createdAt: ts,
          })
          .run()
      }
      message.files = messageFiles(message.id).map((file) => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
      }))
    }

    // Own posts are never the author's unread. On the event-scope scheduler
    // DM the DELIVERY reader is the scheduler: the scheduler's own post
    // advances the stable scheduler key, a solver's ask only the solver's
    // own (observation) cursor.
    if (author.type === "agent") {
      const agent = agentRow(author.agentId)!
      if (channel.scopeType === "event" && agent.role === "orchestrator") {
        advanceSchedulerCursor(channel, message.id)
      } else {
        advanceCursor(channel, author.agentId, message.id)
      }
    }

    // SSE broadcast: run DM channels on the run's channel; challenge-scope
    // group channels + the scheduler DM on the event's channel (challenge
    // channels outlive any single run; timelines poll).
    bus.emit(channel.runId ?? channel.eventId, {
      type: "channel.message",
      message,
    })

    // Delivery policy per channel (§2.3). Deferred: the caller owns delivery
    // (awaited) — see deliverAwaited.
    if (!input.deferDelivery) {
      triggerDelivery(
        channel,
        message,
        input.skipAgentIds ?? [],
        input.deliverAs ?? "steer"
      )
    }
    if (channel.scopeType === "event") {
      deps.onSchedulerDmMessage(channel.eventId, message)
    }
    return message
  }

  /** User multipart upload variant: files arrive as raw bytes. */
  async function postWithUpload(
    input: Omit<PostInput, "files"> & { uploads: AttachmentInput[] }
  ): Promise<ChannelMessagePublic> {
    const channel = requireChannel(input.channelId)
    const body = input.body ?? ""
    if (body.length > MAX_MESSAGE_CHARS) {
      throw new RunActionError(
        "invalid",
        `消息超过 ${MAX_MESSAGE_CHARS} 字符上限（当前 ${body.length}）`
      )
    }
    if (input.uploads.length > MAX_FILES_PER_MESSAGE) {
      throw new RunActionError(
        "invalid",
        `单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`
      )
    }
    let total = 0
    for (const upload of input.uploads) {
      if (upload.size > MAX_FILE_BYTES) {
        throw new RunActionError(
          "invalid",
          `附件超过单文件上限 64MB：${upload.filename}`
        )
      }
      total += upload.size
    }
    if (total > MAX_MESSAGE_TOTAL_BYTES) {
      throw new RunActionError(
        "invalid",
        `单条消息附件总量超过 128MB 上限（${formatSize(total)}）`
      )
    }
    const author = resolveAuthor(channel, input.author)
    const ts = deps.now()
    const inserted = db
      .insert(channelMessages)
      .values({
        channelId: channel.id,
        kind: "text",
        authorType: author.type,
        authorAgentId: author.type === "agent" ? author.agentId : null,
        authorName: author.name,
        body,
        meta: JSON.stringify(serverMeta(author, input.meta)),
        createdAt: ts,
      })
      .returning()
      .get()
    const message = toPublic(inserted)
    if (input.uploads.length > 0) {
      const dir = filesDir(channel.id, message.id)
      mkdirSync(dir, { recursive: true })
      for (const upload of input.uploads) {
        const safe = basename(upload.filename) || "attachment"
        const bytes = Buffer.from(await upload.stream())
        writeFileSync(join(dir, safe), bytes)
        db.insert(channelFiles)
          .values({
            id: crypto.randomUUID(),
            messageId: message.id,
            channelId: channel.id,
            filename: safe,
            size: bytes.byteLength,
            createdAt: ts,
          })
          .run()
      }
      message.files = messageFiles(message.id).map((file) => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
      }))
    }
    bus.emit(channel.runId ?? channel.eventId, {
      type: "channel.message",
      message,
    })
    if (!input.deferDelivery) {
      triggerDelivery(
        channel,
        message,
        input.skipAgentIds ?? [],
        input.deliverAs ?? "steer"
      )
    }
    if (channel.scopeType === "event") {
      deps.onSchedulerDmMessage(channel.eventId, message)
    }
    return message
  }

  /** Author name/permission resolution per channel kind (§2.3 writers).
   * v17 §11.4: agent posts carry a run-suffix snapshot (`Solver 2 · run-a3f1`)
   * — the same string renders in the UI timeline and the steer text, so
   * cross-run attribution is unambiguous in the shared challenge channels. */
  function resolveAuthor(
    channel: ChannelRow,
    author: MessageAuthor
  ):
    | { type: "system"; name: string }
    | { type: "user"; name: string }
    | { type: "agent"; agentId: string; name: string } {
    if (author.type === "system") {
      return { type: "system", name: author.name ?? "system" }
    }
    if (author.type === "user") {
      return { type: "user", name: author.name ?? "用户" }
    }
    const agent = agentRow(author.agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const name = `${agent.name ?? agent.slot} · run-${agent.runId.slice(0, 4)}`
    if (channel.scopeType === "challenge") {
      // Solvers of any run on THIS challenge post to #team (their shared
      // room) and #announce; the event's scheduler may post #announce (and DM
      // steering) but not #team — that is the solvers' room.
      const agentRun = queries.getRow(agent.runId)
      const sameChallenge =
        agentRun?.scopeType === "challenge" &&
        agentRun.challengeId === channel.challengeId
      const scheduler = schedulerAgentOf(channel.eventId)
      if (!sameChallenge && scheduler?.id !== agent.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（不属于此题目，也非本 event 调度者）"
        )
      }
      if (channel.kind === "team" && !sameChallenge) {
        throw new RunActionError(
          "invalid",
          "#team 只接受本题目 run 成员发帖（调度者请用 #announce 或 DM）"
        )
      }
    } else if (channel.scopeType === "run") {
      // Same-run agents post to their own DM; the event's scheduler agent may
      // post to any run's DM (steering) — legacy run-scope DM permission.
      const sameRun = agent.runId === channel.runId
      const scheduler = schedulerAgentOf(channel.eventId)
      if (!sameRun && scheduler?.id !== agent.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（不属于此 run，也非本 event 调度者）"
        )
      }
    }
    // Event-scope scheduler DM: solvers (ask), users, system, the scheduler
    // itself — no further restriction (accepted boundary: no API token).
    return { type: "agent", agentId: agent.id, name }
  }

  /** The event's live scheduler agent (entry agent of its event-scope run). */
  function schedulerAgentOf(
    eventId: string
  ): typeof agents.$inferSelect | undefined {
    const runRow = db
      .select()
      .from(runs)
      .where(and(eq(runs.eventId, eventId), eq(runs.scopeType, "event")))
      .get()
    if (!runRow) return undefined
    return db.select().from(agents).where(eq(agents.runId, runRow.id)).get()
  }

  // --- delivery engine ---------------------------------------------------------

  /** Channels whose unread counts toward an agent's deliver snapshot. Solver:
   * the challenge's #team + #announce (v17 — shared across runs of the
   * challenge) + own DM. The scheduler DM is digest-policy territory. */
  function deliverableChannels(
    agent: typeof agents.$inferSelect
  ): ChannelRow[] {
    const runRow = queries.getRow(agent.runId)
    const groups = runRow?.challengeId
      ? db
          .select()
          .from(channels)
          .where(
            and(
              eq(channels.challengeId, runRow.challengeId),
              inArray(channels.kind, ["team", "announce"])
            )
          )
          .all()
      : []
    const dms = db
      .select()
      .from(channels)
      .where(and(eq(channels.runId, agent.runId), eq(channels.kind, "dm")))
      .all()
    return [...groups, ...dms.filter((c) => c.targetAgentId === agent.id)]
  }

  /** The one push exit: collect unread across the agent's visible channels,
   * render ONE merged steer text (8K cap, overflow folding), advance cursors,
   * lifecycle.send. Red line: group channels only deliver on a live run
   * (closed → store only); DMs may cold-wake (lifecycle onResume).
   *
   * The event-scope scheduler DM never enters this path (it is not a channel
   * of any run) — its delivery policy is the digest. A DIRECT DM to an
   * orchestrator (its run-scope DM, via sendMessage/sendAgentMessage) steers
   * it like any agent. */
  function deliver(
    agentId: string,
    deliverAs: "steer" | "followUp" = "steer"
  ): void {
    void deliverAwaited(agentId, deliverAs).catch(() => undefined)
  }

  /** Awaited variant for the user-facing send wrappers: the push (and any
   * cold-restore it triggers) completes before the caller returns. Errors
   * propagate (the old `await lifecycle.send` contract). */
  async function deliverAwaited(
    agentId: string,
    deliverAs: "steer" | "followUp" = "steer"
  ): Promise<void> {
    const agent = agentRow(agentId)
    if (!agent) return
    const runRow = queries.getRow(agent.runId)
    if (!runRow) return
    const runLive = runRow.status !== "closed"

    type Snapshot = {
      channel: ChannelRow
      messages: ChannelMessageRow[]
      maxId: number
    }
    const snapshots: Snapshot[] = []
    for (const channel of deliverableChannels(agent)) {
      const groupOnly = channel.kind !== "dm"
      if (groupOnly && !runLive) continue // closed run: store only
      const cursor = cursorFor(channel, agentId)
      const rows = db
        .select()
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channel.id),
            gt(channelMessages.id, cursor),
            sql`${channelMessages.kind} != 'recap'`
          )
        )
        .orderBy(asc(channelMessages.id))
        .all()
        .filter(
          (row) =>
            !(row.authorType === "agent" && row.authorAgentId === agentId)
        )
      if (rows.length === 0) continue
      snapshots.push({
        channel,
        messages: rows,
        maxId: rows[rows.length - 1]!.id,
      })
    }
    if (snapshots.length === 0) return

    const text = renderMerged(
      snapshots.map(({ channel, messages }) => ({
        label: channelLabel(channel),
        messages: messages.map((row) => ({
          authorName: row.authorName,
          createdAt: row.createdAt,
          body: row.body,
          files: messageFiles(row.id).map((file) => ({
            filename: file.filename,
            size: file.size,
          })),
        })),
      }))
    )
    for (const { channel, maxId } of snapshots) {
      advanceCursor(channel, agentId, maxId)
    }
    await lifecycle.send(agentId, text, deliverAs)
  }

  /** Per-channel delivery trigger (§2.3 table). v17: group channels are
   * challenge-scoped — the recipient query is every solver of every LIVE run
   * on the challenge (closed-run members only store, per the restore red
   * line); DMs target their agent as before. */
  function triggerDelivery(
    channel: ChannelRow,
    _message: ChannelMessagePublic,
    skipAgentIds: string[],
    deliverAs: "steer" | "followUp"
  ): void {
    if (channel.scopeType === "event") return // scheduler DM → digest policy
    if (channel.kind === "dm") {
      if (
        channel.targetAgentId &&
        !skipAgentIds.includes(channel.targetAgentId)
      ) {
        deliver(channel.targetAgentId, deliverAs)
      }
      return
    }
    // Group channels: steer every live solver on the challenge.
    const liveRuns = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.challengeId, channel.challengeId!),
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .all()
    for (const { id } of liveRuns) {
      for (const agent of queries.listAgents(id)) {
        if (agent.role !== "solver") continue
        if (skipAgentIds.includes(agent.id)) continue
        deliver(agent.id, deliverAs)
      }
    }
  }

  // --- reads ---------------------------------------------------------------------

  function listMessages(
    channelId: string,
    opts: { after?: number; limit?: number } = {}
  ): { items: ChannelMessagePublic[]; nextAfter: number; hasMore: boolean } {
    const channel = requireChannel(channelId)
    const after = opts.after ?? 0
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), 200)
    const rows = db
      .select()
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channel.id),
          gt(channelMessages.id, after)
        )
      )
      .orderBy(desc(channelMessages.id))
      .limit(limit + 1)
      .all()
      .reverse()
    const hasMore = rows.length > limit
    const shown = hasMore ? rows.slice(rows.length - limit) : rows
    return {
      items: shown.map(toPublic),
      nextAfter: shown.length > 0 ? shown[shown.length - 1]!.id : after,
      hasMore,
    }
  }

  /** SDK read: pull = read (marks the cursor). Enforces the reader's
   * visibility. `selector` is a channel id or "#team"/"#announce". */
  function readForAgent(
    agentId: string,
    selector: string,
    opts: { after?: number; limit?: number; markRead?: boolean } = {}
  ): {
    channel: ChannelPublic
    items: ChannelMessagePublic[]
    nextAfter: number
    hasMore: boolean
  } {
    const agent = agentRow(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const channel = resolveSelector(agent, selector)
    const result = listMessages(channel.id, opts)
    if (opts.markRead !== false && result.items.length > 0) {
      advanceCursor(channel, agentId, result.items[result.items.length - 1]!.id)
    }
    return {
      channel: toChannelPublic(channel, agentId),
      ...result,
    }
  }

  /** Resolve "#team" / "#announce" / a channel id for an agent, enforcing
   * visibility (solver: the challenge's group channels + own DM + the event's
   * scheduler DM; scheduler: every channel in its event). */
  function resolveSelector(
    agent: typeof agents.$inferSelect,
    selector: string
  ): ChannelRow {
    const isScheduler = agent.role === "orchestrator"
    // Normalize "team"/"announce" to the "#"-prefixed form (URL path params
    // cannot carry the "#" — the SDK strips it).
    const selectorNorm =
      selector === "team"
        ? "#team"
        : selector === "announce"
          ? "#announce"
          : selector
    if (selectorNorm === "#team" || selectorNorm === "#announce") {
      if (isScheduler) {
        throw new RunActionError(
          "invalid",
          "调度者请用频道 id 寻址 run 频道（channels.list 提供）"
        )
      }
      const runRow = queries.getRow(agent.runId)
      if (!runRow?.challengeId) {
        throw new RunActionError("not_found", "Channel not found")
      }
      const channel = db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.challengeId, runRow.challengeId),
            eq(channels.kind, selectorNorm === "#team" ? "team" : "announce")
          )
        )
        .get()
      if (!channel) throw new RunActionError("not_found", "Channel not found")
      return channel
    }
    const channel = channelById(selectorNorm)
    if (!channel) throw new RunActionError("not_found", "Channel not found")
    const ownRun = queries.getRow(agent.runId)
    if (isScheduler) {
      if (!ownRun || ownRun.eventId !== channel.eventId) {
        throw new RunActionError("invalid", "频道不在本 event 内")
      }
      return channel
    }
    // Solver visibility (v17): the challenge's group channels, own DM, and
    // the event's scheduler DM.
    const visible =
      (channel.scopeType === "challenge" &&
        ownRun?.challengeId === channel.challengeId) ||
      channel.runId === agent.runId ||
      (channel.scopeType === "event" &&
        channel.kind === "dm" &&
        ownRun?.eventId === channel.eventId)
    if (!visible) {
      throw new RunActionError("invalid", "无权读取该频道")
    }
    return channel
  }

  function unreadCount(channel: ChannelRow, agentId: string): number {
    const cursor = cursorFor(channel, agentId)
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channel.id),
          gt(channelMessages.id, cursor),
          sql`${channelMessages.kind} != 'recap'`,
          sql`not (${channelMessages.authorType} = 'agent' and ${channelMessages.authorAgentId} = ${agentId})`
        )
      )
      .get()
    return row?.n ?? 0
  }

  /** Live (running/idle) challenge runs sharing a challenge channel — the
   * v17 共享 badge count. */
  function sharedRunCount(channel: ChannelRow): number | null {
    if (channel.scopeType !== "challenge") return null
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(
        and(
          eq(runs.challengeId, channel.challengeId!),
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .get()
    return row?.n ?? 0
  }

  function toChannelPublic(
    channel: ChannelRow,
    agentId: string
  ): ChannelPublic {
    const last = db
      .select({ createdAt: channelMessages.createdAt })
      .from(channelMessages)
      .where(eq(channelMessages.channelId, channel.id))
      .orderBy(desc(channelMessages.id))
      .limit(1)
      .get()
    return {
      id: channel.id,
      scopeType: channel.scopeType as "run" | "event" | "challenge",
      runId: channel.runId,
      eventId: channel.eventId,
      challengeId: channel.challengeId,
      kind: channel.kind as "team" | "announce" | "dm",
      targetAgentId: channel.targetAgentId,
      label: channelLabel(channel),
      unread: agentId ? unreadCount(channel, agentId) : 0,
      lastMessageAt: last?.createdAt ?? null,
      sharedRunCount: sharedRunCount(channel),
    }
  }

  /** SDK channels.list: the agent's visible channels + unread counts. */
  function agentChannels(agentId: string): ChannelPublic[] {
    const agent = agentRow(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const runRow = queries.getRow(agent.runId)
    if (!runRow) throw new RunActionError("not_found", "Run not found")
    if (agent.role === "orchestrator") {
      return db
        .select()
        .from(channels)
        .where(eq(channels.eventId, runRow.eventId))
        .all()
        .map((channel) => toChannelPublic(channel, agentId))
    }
    const list = runChannels(agent.runId).filter(
      (channel) => channel.kind !== "dm" || channel.targetAgentId === agentId
    )
    const scheduler = schedulerDm(runRow.eventId)
    if (scheduler) list.push(scheduler)
    return list.map((channel) => toChannelPublic(channel, agentId))
  }

  /** UI run channel tree (no per-agent unread — UI unread is client-side
   * session state by design §5.2). */
  function runChannelTree(runId: string): ChannelPublic[] {
    return runChannels(runId).map((channel) => toChannelPublic(channel, ""))
  }

  // --- files ----------------------------------------------------------------------

  function fileById(fileId: string): { row: ChannelFileRow; path: string } {
    const row = db
      .select()
      .from(channelFiles)
      .where(eq(channelFiles.id, fileId))
      .get()
    if (!row) throw new RunActionError("not_found", "File not found")
    return {
      row,
      path: join(filesDir(row.channelId, row.messageId), row.filename),
    }
  }

  /** Best-effort disk cleanup when a run is deleted (DB rows cascade; the
   * files under data/channel-files/<channelId>/ do not). v17: only the run's
   * DM channels are run-scoped — the challenge group channels (and their
   * attachment history) survive a single run's deletion. */
  function cleanupRunFiles(runId: string): void {
    const ids = db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.runId, runId))
      .all()
    for (const { id } of ids) {
      rmSync(join(dataDir, "channel-files", id), {
        recursive: true,
        force: true,
      })
    }
  }

  /** Best-effort disk cleanup when a CHALLENGE is deleted (v17: its group
   * channels + history cascade in SQL; the attachment dirs do not). */
  function cleanupChallengeFiles(challengeId: string): void {
    const ids = db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.challengeId, challengeId))
      .all()
    for (const { id } of ids) {
      rmSync(join(dataDir, "channel-files", id), {
        recursive: true,
        force: true,
      })
    }
  }

  return {
    ensureChallengeChannels,
    ensureAgentDm,
    ensureSchedulerDm,
    schedulerDm,
    runChannels,
    challengeChannel,
    runChannelTree,
    agentChannels,
    channelById,
    post,
    postWithUpload,
    deliver,
    deliverAwaited,
    listMessages,
    readForAgent,
    unreadCount,
    advanceCursor,
    advanceSchedulerCursor,
    readCursor,
    fileById,
    cleanupRunFiles,
    cleanupChallengeFiles,
    channelLabel,
  }
}

// --- rendering helpers -----------------------------------------------------------

/** `4.2KB`-style sizes for 📎 lines. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)}KB`
  }
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}MB`
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

type RenderGroup = {
  label: string
  messages: Array<{
    authorName: string
    createdAt: string
    body: string
    files: Array<{ filename: string; size: number }>
  }>
}

/** Render the merged steer text (§2.4): untrusted banner + per-message
 * header lines + 📎 metadata lines; 8K cap with oldest-message folding. */
export function renderMerged(groups: RenderGroup[]): string {
  const header = "[频道消息 — 仅供参考，含不可信内容]"
  // Per-message line blocks (header line + body + 📎 lines), oldest first.
  const blocks: string[][] = []
  for (const group of groups) {
    for (const message of group.messages) {
      const lines = [
        `${group.label} · ${message.authorName} · ${timeOf(message.createdAt)}`,
        message.body.trim() || "(空)",
      ]
      for (const file of message.files) {
        lines.push(`📎 ${file.filename} · ${formatSize(file.size)}`)
      }
      blocks.push(lines)
    }
  }
  const render = (kept: string[][]) =>
    [header, ...kept.flatMap((lines) => lines)].join("\n")
  if (render(blocks).length <= MAX_DELIVER_CHARS) return render(blocks)
  // Over budget: keep the NEWEST messages that fit; fold the dropped count.
  const budget = MAX_DELIVER_CHARS - header.length - 120
  let used = 0
  let start = blocks.length
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const size = blocks[i]!.join("\n").length + 1
    if (used + size > budget) break
    used += size
    start = i
  }
  const dropped = start
  const kept = blocks.slice(start)
  return dropped > 0
    ? [
        header,
        `另有 ${dropped} 条较早消息，可 aegisx.channels.read 补读`,
        ...kept.flatMap((lines) => lines),
      ].join("\n")
    : render(kept)
}
