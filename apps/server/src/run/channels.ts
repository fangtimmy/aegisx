import {
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"

import type {
  ChannelMessageList,
  ChannelMessagePublic,
  ChannelPublic,
} from "@aegisx/shared/channels"
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm"

import type { SessionLifecycle } from "../agents/lifecycle"
import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import {
  agents,
  challenges,
  channelFiles,
  channelMessages,
  channelReads,
  runs,
} from "../db/schema"
import { RunActionError } from "./errors"
import type { RunQueries } from "./queries"

/**
 * Derived-key channel core (docs/im-simplify-v18.md). A channel is NOT a
 * table row — it is a derived key:
 *
 *   #team          team:<challengeId>   same-challenge knowledge base shared
 *                                       by every run on the challenge (v17
 *                                       semantics kept: cross-run history,
 *                                       onboarding sweep, run-signed authors,
 *                                       closed runs store-only)
 *   DM solver-N    dm:<agentId>         scheduler / user / system → one solver
 *   DM scheduler   orch:<eventId>       solver asks + system run/queue events
 *                                       → the scheduler (stable "scheduler"
 *                                       read cursor across scheduler restarts)
 *
 * The first message makes a channel exist; there is no directory table and
 * no get-or-create. Delivery is ONE policy for all three kinds (§3.2):
 * post persists first (crash-safe), then urgent=true delivers immediately,
 * everything else rides the global flush tick (N=5min). The one push exit
 * is deliverAgent — one reader, one steer, the whole backlog.
 *
 * Cold-wake red line (§3.3): urgent dm deliveries may cold-restore a closed
 * run (lifecycle.send → onResume — the old message_agent semantics); team
 * and orch only ever store for closed runs (restore touches only the
 * triggered agent).
 */

/** Server-side message body cap (characters). */
const MAX_MESSAGE_CHARS = 16_000
/** Per-file attachment cap. */
const MAX_FILE_BYTES = 64 * 1024 * 1024
/** Per-message attachment caps. */
const MAX_FILES_PER_MESSAGE = 8
const MAX_MESSAGE_TOTAL_BYTES = 128 * 1024 * 1024
/** Deliver merged-text cap (characters); overflow folds to a catch-up line. */
const MAX_DELIVER_CHARS = 8_000
/** Default page size for timeline reads. */
const DEFAULT_PAGE = 50

/** Flush tick interval (§3.4): non-urgent messages merge-deliver every N
 * minutes. Code constant; tests override via `flushIntervalMs`. */
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

export type ChannelMessageRow = typeof channelMessages.$inferSelect
export type ChannelFileRow = typeof channelFiles.$inferSelect

export type {
  ChannelMessageList,
  ChannelMessagePublic,
  ChannelPublic,
} from "@aegisx/shared/channels"

export type MessageAuthor =
  | { type: "system"; name?: string }
  | { type: "user"; name?: string }
  | { type: "agent"; agentId: string; name?: string }

export type PostInput = {
  channelKey: string
  author: MessageAuthor
  body: string
  /** §3.2: urgent=true → immediate deliverChannel; otherwise the flush tick
   * merges it. Defaults per writer are the CALLER's business (SDK/UI/system
   * call sites encode the §3.2 matrix). */
  urgent?: boolean
  meta?: Record<string, unknown>
  /** Workspace-relative paths copied out of the POSTING agent's run
   * workspace (snapshot semantics, §六). */
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
  queries: RunQueries
  /** Late-bound lifecycle getter (the delivery engine calls lifecycle.send;
   * the service constructs channels before the lifecycle — the getter is
   * only invoked after both exist). */
  lifecycle(): SessionLifecycle
  now(): string
  /** Absolute host workspace path for a run (attachment source / validation). */
  workspaceAbs(runId: string): string
  /** Test seam: flush tick interval. */
  flushIntervalMs?: number
}

export type ChannelService = ReturnType<typeof createChannelService>

export function createChannelService(deps: ChannelServiceDeps) {
  const { db, dataDir, bus, queries } = deps
  const intervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS

  // --- hold (deliveryPaused, per event — §3.4) --------------------------------

  /** Paused events: the tick AND urgent deliveries skip them entirely (posts
   * only store); the next tick/urgent after resume catches up. In-memory
   * only (a service restart resets it — same lifetime as the old digest's
   * hold). */
  const deliveryPausedEvents = new Set<string>()

  function setDeliveryPaused(eventId: string, paused: boolean): void {
    if (paused) deliveryPausedEvents.add(eventId)
    else deliveryPausedEvents.delete(eventId)
  }

  function isDeliveryPaused(eventId: string): boolean {
    return deliveryPausedEvents.has(eventId)
  }

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

  /** The event's scheduler agent (entry agent of the single event-scope run;
   * at most one row exists per event — a fresh start deletes the closed row
   * first). */
  function schedulerAgentOf(
    eventId: string
  ): typeof agents.$inferSelect | undefined {
    const runRow = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.eventId, eventId), eq(runs.scopeType, "event")))
      .get()
    if (!runRow) return undefined
    return db.select().from(agents).where(eq(agents.runId, runRow.id)).get()
  }

  function channelLabel(key: ParsedChannelKey): string {
    if (key.kind === "team") return "#team"
    if (key.kind === "orch") return "#orch"
    const target = agentRow(key.id)
    return `DM ${target?.name ?? target?.slot ?? "agent"}`
  }

  // --- read cursors (§3.5: 已读 = 投递状态) ---------------------------------------

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

  // --- messages + attachments -----------------------------------------------------

  function filesDir(messageId: number): string {
    return join(dataDir, "channel-files", String(messageId))
  }

  function messageFiles(messageId: number): ChannelFileRow[] {
    return db
      .select()
      .from(channelFiles)
      .where(eq(channelFiles.messageId, messageId))
      .orderBy(asc(channelFiles.createdAt), asc(channelFiles.id))
      .all()
  }

  /** Roll back a message whose attachment write failed part-way: drop the
   * file rows + the message row + the flat files dir so no orphan state
   * remains. The author cursor / SSE emit / delivery all run after the
   * attachment block, so nothing else needs undoing. */
  function rollbackMessage(messageId: number) {
    db.delete(channelFiles).where(eq(channelFiles.messageId, messageId)).run()
    db.delete(channelMessages).where(eq(channelMessages.id, messageId)).run()
    rmSync(filesDir(messageId), { recursive: true, force: true })
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
      channelKey: row.channelKey,
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
   * their run id (spoof-proof attribution; callers may not override it) and
   * urgent=true collapses to a single flag. */
  function serverMeta(
    author: { type: "system" | "user" | "agent"; agentId?: string },
    meta: Record<string, unknown> | undefined,
    urgent: boolean
  ): Record<string, unknown> {
    const stamped: Record<string, unknown> = { ...meta }
    if (urgent) stamped.urgent = true
    else delete stamped.urgent
    if (author.type === "agent" && author.agentId) {
      const agent = agentRow(author.agentId)
      stamped.runId = agent?.runId ?? null
    }
    return stamped
  }

  function insertMessage(
    key: string,
    author:
      | { type: "system"; name: string }
      | { type: "user"; name: string }
      | { type: "agent"; agentId: string; name: string },
    body: string,
    meta: Record<string, unknown>
  ): ChannelMessagePublic {
    const ts = deps.now()
    const inserted = db
      .insert(channelMessages)
      .values({
        channelKey: key,
        authorType: author.type,
        authorAgentId: author.type === "agent" ? author.agentId : null,
        authorName: author.name,
        body,
        meta: JSON.stringify(meta),
        createdAt: ts,
      })
      .returning()
      .get()
    return toPublic(inserted)
  }

  /** Post one message (the single write path): persist first (crash-safe),
   * snapshot attachments, advance the author's own cursor, broadcast SSE,
   * then apply the urgent/tick delivery policy. Sync — the workspace
   * attachment copy is a filesystem copy. */
  function post(input: PostInput): ChannelMessagePublic {
    const parsed = requireKey(input.channelKey)
    const body = input.body ?? ""
    if (body.length > MAX_MESSAGE_CHARS) {
      throw new RunActionError(
        "invalid",
        `消息超过 ${MAX_MESSAGE_CHARS} 字符上限（当前 ${body.length}）`
      )
    }
    const urgent = input.urgent === true
    // Author resolution + write permission (the 3 rules, §2.1).
    const author = resolveAuthor(parsed, input.author)

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
        const resolved = resolveWorkspaceFile(agent.runId, path)
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

    const message = insertMessage(
      parsed.raw,
      author,
      body,
      serverMeta(author, input.meta, urgent)
    )

    // Snapshot-copy attachments (post-time freeze, §六). On any failure the
    // partial message is rolled back so a failed post never leaves a
    // message with missing attachments.
    if (sources.length > 0) {
      storeFileCopies(message.id, sources)
      message.files = messageFiles(message.id).map((file) => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
      }))
    }

    // Own posts are never the author's unread (§3.5 progression point 3).
    if (author.type === "agent") {
      markRead(parsed.raw, author.agentId, message.id)
    }

    emitChannelMessage(parsed, message)

    if (urgent) {
      deliverChannel(parsed.raw, input.deliverAs ?? "steer")
    }
    return message
  }

  /** User multipart upload variant: files arrive as raw bytes. `urgent`
   * defaults TRUE on this path (§3.2 — a user IM post is rare and intended,
   * carrying over the old "user post flushes immediately" semantics). */
  async function postWithUpload(
    input: Omit<PostInput, "files"> & { uploads: AttachmentInput[] }
  ): Promise<ChannelMessagePublic> {
    const parsed = requireKey(input.channelKey)
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
    const urgent = input.urgent ?? true
    const author = resolveAuthor(parsed, input.author)
    const message = insertMessage(
      parsed.raw,
      author,
      body,
      serverMeta(author, input.meta, urgent)
    )
    if (input.uploads.length > 0) {
      await storeUploads(message.id, input.uploads)
      message.files = messageFiles(message.id).map((file) => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
      }))
    }
    if (author.type === "agent") {
      markRead(parsed.raw, author.agentId, message.id)
    }
    emitChannelMessage(parsed, message)
    if (urgent) {
      deliverChannel(parsed.raw, input.deliverAs ?? "steer")
    }
    return message
  }

  function requireKey(raw: string): ParsedChannelKey & { raw: string } {
    const parsed = parseChannelKey(raw)
    if (!parsed) {
      throw new RunActionError("invalid", `非法频道键：${raw}`)
    }
    return { ...parsed, raw }
  }

  /** Snapshot-copy workspace attachments for a freshly inserted message;
   * rolls the message back on any failure so a failed post never leaves a
   * message with missing attachments. */
  function storeFileCopies(
    messageId: number,
    sources: Array<{ abs: string; filename: string; size: number }>
  ): void {
    const dir = filesDir(messageId)
    const ts = deps.now()
    try {
      mkdirSync(dir, { recursive: true })
      for (const source of sources) {
        copyFileSync(source.abs, join(dir, source.filename))
        db.insert(channelFiles)
          .values({
            id: crypto.randomUUID(),
            messageId,
            filename: source.filename,
            size: source.size,
            createdAt: ts,
          })
          .run()
      }
    } catch (error) {
      rollbackMessage(messageId)
      throw error
    }
  }

  /** Write uploaded attachment bytes (user multipart path); same rollback
   * contract as storeFileCopies. */
  async function storeUploads(
    messageId: number,
    uploads: AttachmentInput[]
  ): Promise<void> {
    const dir = filesDir(messageId)
    const ts = deps.now()
    try {
      mkdirSync(dir, { recursive: true })
      for (const upload of uploads) {
        const safe = basename(upload.filename) || "attachment"
        writeFileSync(join(dir, safe), Buffer.from(await upload.stream()))
        db.insert(channelFiles)
          .values({
            id: crypto.randomUUID(),
            messageId,
            filename: safe,
            size: upload.size,
            createdAt: ts,
          })
          .run()
      }
    } catch (error) {
      rollbackMessage(messageId)
      throw error
    }
  }

  /** SSE split (§9.2): dm → the target's run channel; team/orch → the
   * event's channel. */
  function emitChannelMessage(
    parsed: ParsedChannelKey,
    message: ChannelMessagePublic
  ): void {
    const channel = emitChannelOf(parsed)
    if (channel) {
      bus.emit(channel, { type: "channel.message", message })
    }
  }

  function emitChannelOf(parsed: ParsedChannelKey): string | undefined {
    if (parsed.kind === "dm") return agentRow(parsed.id)?.runId
    if (parsed.kind === "orch") return parsed.id
    return challengeRow(parsed.id)?.eventId
  }

  /** Author name/permission resolution — the three write rules (§2.1).
   * Agent posts carry a run-suffix snapshot (`Solver 2 · run-a3f1`, v17
   * §11.4) — the same string renders in the UI timeline and the steer text. */
  function resolveAuthor(
    parsed: ParsedChannelKey,
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
    if (parsed.kind === "team") {
      // Writers: this challenge's solvers, the event's scheduler, user,
      // system. (v18: the scheduler posts #team — its signed agent post IS
      // the announcement; #announce is gone.)
      const agentRun = queries.getRow(agent.runId)
      const sameChallenge =
        agentRun?.scopeType === "challenge" &&
        agentRun.challengeId === parsed.id
      const scheduler = schedulerAgentOf(
        challengeRow(parsed.id)?.eventId ?? ""
      )
      if (!sameChallenge && scheduler?.id !== agent.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（不属于此题目，也非本 event 调度者）"
        )
      }
    } else if (parsed.kind === "dm") {
      // Writers: the event's scheduler, user, system — the target agent
      // itself never writes its own DM.
      if (agent.id === parsed.id) {
        throw new RunActionError(
          "invalid",
          "DM 目标 agent 不能向自己的 DM 发帖（用 #team 或 ask）"
        )
      }
      const target = agentRow(parsed.id)
      const targetRun = target ? queries.getRow(target.runId) : undefined
      const scheduler = schedulerAgentOf(targetRun?.eventId ?? "")
      if (scheduler?.id !== agent.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（仅本 event 调度者可向 solver DM 发帖）"
        )
      }
    } else {
      // orch: solvers of this event (ask), user, system. The scheduler agent
      // itself never writes orch (it RECEIVES it).
      const agentRun = queries.getRow(agent.runId)
      if (agent.role === "orchestrator") {
        throw new RunActionError(
          "invalid",
          "调度者不写 orch 频道（它是调度者的收件频道）"
        )
      }
      if (agentRun?.eventId !== parsed.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（不属于此 event）"
        )
      }
    }
    return { type: "agent", agentId: agent.id, name }
  }

  // --- delivery engine (§3.3) ------------------------------------------------------

  /** The functional read key of an agent: solvers read under their own id;
   * the scheduler reads orch under the stable "scheduler" key. */
  function readerKeyOf(agent: typeof agents.$inferSelect): string {
    return agent.role === "orchestrator" ? SCHEDULER_READ_KEY : agent.id
  }

  /** The agent's delivery face (§3.3): solver = its challenge's #team + own
   * dm; scheduler = orch. */
  function deliveryKeys(agent: typeof agents.$inferSelect): string[] {
    const runRow = queries.getRow(agent.runId)
    if (!runRow) return []
    if (agent.role === "orchestrator") return [orchKey(runRow.eventId)]
    const keys: string[] = []
    if (runRow.challengeId) keys.push(teamKey(runRow.challengeId))
    keys.push(dmKey(agent.id))
    return keys
  }

  /** The one push exit: collect unread across the agent's delivery face,
   * render ONE merged text (8K cap, overflow folding, ⚠ urgent marks),
   * advance cursors, lifecycle.send. Cold-wake red line: team/orch only
   * deliver on a live run; dm may cold-restore a closed run when the caller
   * is an urgent post (coldWake=true). */
  async function deliverAgentAwaited(
    agentId: string,
    opts: { coldWake?: boolean; deliverAs?: "steer" | "followUp" } = {}
  ): Promise<void> {
    const agent = agentRow(agentId)
    if (!agent) return
    const runRow = queries.getRow(agent.runId)
    if (!runRow) return
    if (isDeliveryPaused(runRow.eventId)) return
    const runLive = runRow.status !== "closed"
    if (!runLive && !opts.coldWake) return
    const readerKey = readerKeyOf(agent)
    const coldWake = opts.coldWake === true

    type Snapshot = {
      key: string
      label: string
      messages: ChannelMessageRow[]
      maxId: number
    }
    const snapshots: Snapshot[] = []
    for (const key of deliveryKeys(agent)) {
      const parsed = parseChannelKey(key)!
      if (parsed.kind !== "dm" && !runLive) continue // closed: store only
      if (parsed.kind === "dm" && !runLive && !coldWake) continue
      const cursor = readCursor(key, readerKey)
      const rows = db
        .select()
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelKey, key),
            gt(channelMessages.id, cursor)
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
        key,
        label: channelLabel(parsed),
        messages: rows,
        maxId: rows[rows.length - 1]!.id,
      })
    }
    if (snapshots.length === 0) return

    const text = renderMerged(
      snapshots.map(({ label, messages }) => ({
        label,
        messages: messages.map((row) => ({
          authorName: row.authorName,
          createdAt: row.createdAt,
          body: row.body,
          urgent: isUrgent(row),
          files: messageFiles(row.id).map((file) => ({
            filename: file.filename,
            size: file.size,
          })),
        })),
      }))
    )
    for (const { key, maxId } of snapshots) {
      markRead(key, readerKey, maxId)
    }
    await deps.lifecycle().send(agentId, text, opts.deliverAs ?? "steer")
  }

  function isUrgent(row: ChannelMessageRow): boolean {
    try {
      return JSON.parse(row.meta)?.urgent === true
    } catch {
      return false
    }
  }

  /** Fire-and-forget delivery (onboarding sweep after prime — v17 §11.3
   * semantics kept: a fresh solver's cursor is 0, one deliver sweeps the
   * challenge's whole #team history into its first turn's tail). */
  function deliver(agentId: string): void {
    void deliverAgentAwaited(agentId).catch(() => undefined)
  }

  /** Urgent-post delivery trigger (§3.2/§3.3 matrix):
   *  - team → every live run's solvers on the challenge (closed: store only)
   *  - dm   → the target agent, cold-waking a closed run (lifecycle.send →
   *           onResume — restore touches ONLY the triggered agent)
   *  - orch → the event's scheduler, only if its run is live (closed → store;
   *           the stable "scheduler" cursor catches up on next start) */
  function deliverChannel(
    key: string,
    deliverAs: "steer" | "followUp" = "steer"
  ): void {
    const parsed = parseChannelKey(key)
    if (!parsed) return
    if (isDeliveryPaused(eventOfKey(parsed))) return
    if (parsed.kind === "team") {
      const liveRuns = db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.challengeId, parsed.id),
            eq(runs.scopeType, "challenge"),
            inArray(runs.status, ["running", "idle"])
          )
        )
        .all()
      for (const { id } of liveRuns) {
        for (const agent of queries.listAgents(id)) {
          if (agent.role !== "solver") continue
          void deliverAgentAwaited(agent.id, { deliverAs }).catch(
            () => undefined
          )
        }
      }
      return
    }
    if (parsed.kind === "dm") {
      void deliverAgentAwaited(parsed.id, { coldWake: true, deliverAs }).catch(
        () => undefined
      )
      return
    }
    // orch: only a live scheduler run receives pushes.
    const schedRun = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.eventId, parsed.id), eq(runs.scopeType, "event")))
      .get()
    if (!schedRun) return
    if (
      db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, schedRun.id))
        .get()?.status === "closed"
    ) {
      return
    }
    const orch = db
      .select()
      .from(agents)
      .where(eq(agents.runId, schedRun.id))
      .get()
    if (orch) {
      void deliverAgentAwaited(orch.id, { deliverAs }).catch(() => undefined)
    }
  }

  function eventOfKey(parsed: ParsedChannelKey): string {
    if (parsed.kind === "orch") return parsed.id
    if (parsed.kind === "team") {
      return challengeRow(parsed.id)?.eventId ?? ""
    }
    const target = agentRow(parsed.id)
    return target ? (queries.getRow(target.runId)?.eventId ?? "") : ""
  }

  // --- flush tick (§3.4) -----------------------------------------------------------

  let flushTimer: ReturnType<typeof setInterval> | null = null
  let nextFlushAt: number | null = null

  /** One global interval; no per-event objects, no catch-up code — messages
   * are persisted, so a missed tick's backlog settles on the next one. */
  function startFlushLoop(): void {
    if (flushTimer) return
    nextFlushAt = Date.now() + intervalMs
    flushTimer = setInterval(() => runFlushTick(), intervalMs)
  }

  /** The tick: every live (running/idle) run's solvers deliverAgent; every
   * live scheduler agent delivers from orch. Hold skips the whole event. */
  function runFlushTick(): void {
    nextFlushAt = Date.now() + intervalMs
    try {
      const live = db
        .select({
          id: runs.id,
          scopeType: runs.scopeType,
          eventId: runs.eventId,
        })
        .from(runs)
        .where(inArray(runs.status, ["running", "idle"]))
        .all()
      for (const row of live) {
        if (isDeliveryPaused(row.eventId)) continue
        if (row.scopeType === "event") {
          const orch = db
            .select()
            .from(agents)
            .where(eq(agents.runId, row.id))
            .get()
          if (orch) {
            void deliverAgentAwaited(orch.id).catch(() => undefined)
          }
          continue
        }
        for (const agent of queries.listAgents(row.id)) {
          if (agent.role !== "solver") continue
          void deliverAgentAwaited(agent.id).catch(() => undefined)
        }
      }
    } catch (error) {
      console.error("channel flush tick failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // --- reads / listings ---------------------------------------------------------------

  function listMessages(
    channelKey: string,
    opts: { after?: number; limit?: number } = {}
  ): ChannelMessageList {
    requireKey(channelKey)
    const after = opts.after ?? 0
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), 200)
    const rows = db
      .select()
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelKey, channelKey),
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

  /** SDK read: pull = read (marks the cursor). `selector` is "#team" (or
   * "team"), "orch", or a raw channel key; visibility enforced. */
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
    const key = resolveSelector(agent, selector)
    const result = listMessages(key, opts)
    const readerKey = readerKeyOf(agent)
    if (opts.markRead !== false && result.items.length > 0) {
      markRead(key, readerKey, result.items[result.items.length - 1]!.id)
    }
    return {
      channel: channelInfo(parseChannelKey(key)!, agentId),
      ...result,
    }
  }

  /** Resolve "#team"/"team"/"orch"/a raw key for an agent, enforcing
   * visibility (§2.2: solver = own team + own dm + orch; scheduler = every
   * team + every dm + orch of its event). */
  function resolveSelector(
    agent: typeof agents.$inferSelect,
    selector: string
  ): string {
    const runRow = queries.getRow(agent.runId)
    if (!runRow) throw new RunActionError("not_found", "Run not found")
    const norm = selector === "team" ? "#team" : selector
    if (norm === "#team") {
      if (agent.role === "orchestrator" || !runRow.challengeId) {
        throw new RunActionError(
          "invalid",
          "调度者请用 channels.list 返回的键寻址题目频道"
        )
      }
      return teamKey(runRow.challengeId)
    }
    if (norm === "orch") return orchKey(runRow.eventId)
    const parsed = parseChannelKey(norm)
    if (!parsed) throw new RunActionError("not_found", "Channel not found")
    if (!visibleTo(agent, runRow, parsed)) {
      throw new RunActionError("invalid", "无权读取该频道")
    }
    return norm
  }

  function visibleTo(
    agent: typeof agents.$inferSelect,
    runRow: { challengeId: string | null; eventId: string },
    parsed: ParsedChannelKey
  ): boolean {
    if (agent.role === "orchestrator") {
      if (parsed.kind === "orch") return runRow.eventId === parsed.id
      if (parsed.kind === "team") {
        return challengeRow(parsed.id)?.eventId === runRow.eventId
      }
      const target = agentRow(parsed.id)
      const targetRun = target ? queries.getRow(target.runId) : undefined
      return targetRun?.eventId === runRow.eventId
    }
    if (parsed.kind === "team") return runRow.challengeId === parsed.id
    if (parsed.kind === "dm") return agent.id === parsed.id
    return runRow.eventId === parsed.id
  }

  function unreadCount(key: string, readerKey: string): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelKey, key),
          gt(channelMessages.id, readCursor(key, readerKey)),
          sql`not (${channelMessages.authorType} = 'agent' and ${channelMessages.authorAgentId} = ${readerKey})`
        )
      )
      .get()
    return row?.n ?? 0
  }

  /** Live (running/idle) challenge runs sharing a team channel — the v17
   * 共享 badge count. */
  function sharedRunCount(challengeId: string): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(
        and(
          eq(runs.challengeId, challengeId),
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .get()
    return row?.n ?? 0
  }

  function channelInfo(
    parsed: ParsedChannelKey,
    readerKey: string | null
  ): ChannelPublic {
    let eventId = ""
    let challengeId: string | null = null
    let agentId: string | null = null
    let runId: string | null = null
    let shared: number | null = null
    if (parsed.kind === "team") {
      const challenge = challengeRow(parsed.id)
      eventId = challenge?.eventId ?? ""
      challengeId = parsed.id
      shared = sharedRunCount(parsed.id)
    } else if (parsed.kind === "dm") {
      const target = agentRow(parsed.id)
      runId = target?.runId ?? null
      agentId = parsed.id
      eventId = target
        ? (queries.getRow(target.runId)?.eventId ?? "")
        : ""
    } else {
      eventId = parsed.id
    }
    const last = db
      .select({ createdAt: channelMessages.createdAt })
      .from(channelMessages)
      .where(eq(channelMessages.channelKey, `${parsed.kind}:${parsed.id}`))
      .orderBy(desc(channelMessages.id))
      .limit(1)
      .get()
    return {
      key: `${parsed.kind}:${parsed.id}`,
      kind: parsed.kind,
      label: channelLabel(parsed),
      eventId,
      challengeId,
      agentId,
      runId,
      unread: readerKey ? unreadCount(`${parsed.kind}:${parsed.id}`, readerKey) : 0,
      lastMessageAt: last?.createdAt ?? null,
      sharedRunCount: shared,
    }
  }

  /** SDK channels.list (§2.2): solver = own #team + own dm + orch; scheduler
   * = every #team of its event's challenges + every dm of its event's
   * solver agents + orch. */
  function agentChannels(agentId: string): ChannelPublic[] {
    const agent = agentRow(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const runRow = queries.getRow(agent.runId)
    if (!runRow) throw new RunActionError("not_found", "Run not found")
    const readerKey = readerKeyOf(agent)
    if (agent.role === "orchestrator") {
      const out: ChannelPublic[] = []
      const eventChallenges = db
        .select()
        .from(challenges)
        .where(eq(challenges.eventId, runRow.eventId))
        .orderBy(asc(challenges.name))
        .all()
      for (const challenge of eventChallenges) {
        out.push(channelInfo(parseChannelKey(teamKey(challenge.id))!, readerKey))
      }
      out.push(channelInfo(parseChannelKey(orchKey(runRow.eventId))!, readerKey))
      const eventRuns = db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.eventId, runRow.eventId),
            eq(runs.scopeType, "challenge")
          )
        )
        .orderBy(asc(runs.createdAt))
        .all()
      for (const run of eventRuns) {
        for (const candidate of queries.listAgents(run.id)) {
          if (candidate.role !== "solver") continue
          out.push(channelInfo(parseChannelKey(dmKey(candidate.id))!, readerKey))
        }
      }
      return out
    }
    return [
      ...(runRow.challengeId
        ? [channelInfo(parseChannelKey(teamKey(runRow.challengeId))!, readerKey)]
        : []),
      channelInfo(parseChannelKey(dmKey(agent.id))!, readerKey),
      channelInfo(parseChannelKey(orchKey(runRow.eventId))!, readerKey),
    ]
  }

  /** UI run channel tree (§9.1): #team + one DM per solver. No per-reader
   * unread — UI unread is client-side session state by design. */
  function runChannelTree(runId: string): ChannelPublic[] {
    const runRow = queries.getRow(runId)
    if (!runRow) throw new RunActionError("not_found", "Run not found")
    const out: ChannelPublic[] = []
    if (runRow.challengeId) {
      out.push(channelInfo(parseChannelKey(teamKey(runRow.challengeId))!, null))
    }
    for (const agent of queries.listAgents(runId)) {
      if (agent.role !== "solver") continue
      out.push(channelInfo(parseChannelKey(dmKey(agent.id))!, null))
    }
    return out
  }

  /** The challenge's #team (§9.1: exactly one) — the challenge-level IM view
   * (v17 knowledge base; works with no run on the challenge). */
  function challengeChannelTree(challengeId: string): ChannelPublic[] {
    if (!challengeRow(challengeId)) {
      throw new RunActionError("not_found", "Challenge not found")
    }
    return [channelInfo(parseChannelKey(teamKey(challengeId))!, null)]
  }

  /** Simplified scheduler inbox snapshot (§9.1): the orch key + unread
   * (stable scheduler cursor) + tick state + hold. */
  function inboxSnapshot(eventId: string): {
    channelKey: string
    unreadCount: number
    nextFlushAt: number | null
    deliveryPaused: boolean
  } {
    return {
      channelKey: orchKey(eventId),
      unreadCount: unreadCount(orchKey(eventId), SCHEDULER_READ_KEY),
      nextFlushAt,
      deliveryPaused: isDeliveryPaused(eventId),
    }
  }

  // --- files ----------------------------------------------------------------------

  function fileById(fileId: string): { row: ChannelFileRow; path: string } {
    const row = db
      .select()
      .from(channelFiles)
      .where(eq(channelFiles.id, fileId))
      .get()
    if (!row) throw new RunActionError("not_found", "File not found")
    return { row, path: join(filesDir(row.messageId), row.filename) }
  }

  // --- explicit cleanup (§八: no FK cascades — derived keys need sweeps) ----------

  /** Delete the messages + read cursors + attachment dirs for the given
   * channel keys (channel_files rows cascade from their messages). */
  function deleteChannelData(keys: string[]): void {
    if (keys.length === 0) return
    const messageIds = db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(inArray(channelMessages.channelKey, keys))
      .all()
    db.delete(channelMessages)
      .where(inArray(channelMessages.channelKey, keys))
      .run()
    db.delete(channelReads)
      .where(inArray(channelReads.channelKey, keys))
      .run()
    for (const { id } of messageIds) {
      rmSync(filesDir(id), { recursive: true, force: true })
    }
  }

  /** Run deletion: each agent's dm:<aid> data goes (its #team posts stay —
   * the knowledge base survives single runs). */
  function cleanupRunChannels(runId: string): void {
    const keys = queries
      .listAgents(runId)
      .map((agent) => dmKey(agent.id))
    deleteChannelData(keys)
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
    for (const challenge of db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()) {
      keys.push(teamKey(challenge.id))
    }
    for (const run of db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.eventId, eventId))
      .all()) {
      for (const agent of queries.listAgents(run.id)) {
        keys.push(dmKey(agent.id))
      }
    }
    deleteChannelData(keys)
  }

  function close(): void {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    nextFlushAt = null
    deliveryPausedEvents.clear()
  }

  startFlushLoop()

  return {
    // keys
    teamKey,
    dmKey,
    orchKey,
    parseChannelKey,
    // write paths
    post,
    postWithUpload,
    // delivery engine
    deliver,
    deliverAgentAwaited,
    deliverChannel,
    runFlushTick,
    // cursors
    readCursor,
    markRead,
    // reads / listings
    listMessages,
    readForAgent,
    agentChannels,
    runChannelTree,
    challengeChannelTree,
    unreadCount,
    channelInfo,
    // hold + inbox
    setDeliveryPaused,
    isDeliveryPaused,
    inboxSnapshot,
    // files
    fileById,
    // cleanup
    deleteChannelData,
    cleanupRunChannels,
    cleanupChallengeChannels,
    cleanupEventChannels,
    // lifecycle
    close,
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
    urgent: boolean
    files: Array<{ filename: string; size: number }>
  }>
}

/** Render the merged delivery text: untrusted banner + per-message header
 * lines (⚠ prefix on urgent) + 📎 metadata lines; 8K cap with
 * oldest-message folding. Attachment CONTENT never enters the text. */
export function renderMerged(groups: RenderGroup[]): string {
  const header = "[频道消息 — 仅供参考，含不可信内容]"
  // Per-message line blocks (header line + body + 📎 lines), oldest first.
  const blocks: string[][] = []
  for (const group of groups) {
    for (const message of group.messages) {
      const mark = message.urgent ? "⚠ " : ""
      const lines = [
        `${mark}${group.label} · ${message.authorName} · ${timeOf(message.createdAt)}`,
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
