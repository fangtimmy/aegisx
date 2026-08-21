import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"

import { isActiveAgentStatus, LIVE_AGENT_STATUSES } from "@aegisx/shared"
import type {
  ChannelFileMeta,
  ChannelMessageList,
  ChannelMessageMeta,
  ChannelMessagePublic,
  ChannelPublic,
} from "@aegisx/shared/channels"
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm"

import type { SessionLifecycle } from "../agents/lifecycle"
import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import {
  agents,
  challenges,
  channelMessages,
  channelReads,
  promptTemplates,
} from "../db/schema"
import { DEFAULT_CHANNEL_DELIVERY_TEMPLATE } from "../orchestration/prompt-defaults"
import {
  BUILTIN_PLUGIN,
  type DeliveryRenderContext,
  renderTemplateBody,
} from "../orchestration/prompt-templates"
import { RunActionError } from "./errors"
import { schedulerPolicyFor } from "./scheduler-policy"

/**
 * Derived-key channel core (docs/model-v19-challenge-centric.md §三). A
 * channel is NOT a table row — it is a derived key:
 *
 *   #team          team:<challengeId>   same-challenge knowledge base shared
 *                                       by every agent on the challenge
 *   DM agent       dm:<agentId>         scheduler / user / system → one agent
 *   DM scheduler   orch:<eventId>       solver asks + system agent/queue
 *                                       events → the scheduler (stable
 *                                       "scheduler" read cursor across
 *                                       scheduler restarts)
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

export type ChannelMessageRow = typeof channelMessages.$inferSelect

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
  /** Late-bound lifecycle getter (the delivery engine calls lifecycle.send;
   * the service constructs channels before the lifecycle — the getter is
   * only invoked after both exist). */
  lifecycle(): SessionLifecycle
  now(): string
  /** Host root of a challenge's workspace tree (attachment copy target). */
  challengeWorkspaceRoot(eventId: string, challengeId: string): string
  /** Renders the fleet snapshot appended to every scheduler (orch)
   * delivery; return "" to skip. Wired by the run service (owns the
   * fleet/scheduler domain); absent in tests. */
  renderSchedulerDigest?(eventId: string): string
  /** Test seam: flush tick interval. */
  flushIntervalMs?: number
}

export type ChannelService = ReturnType<typeof createChannelService>

export function createChannelService(deps: ChannelServiceDeps) {
  const { db, dataDir, bus } = deps
  const intervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS

  // --- hold (deliveryPaused, per event) --------------------------------

  /** Paused events: the tick AND urgent deliveries skip them entirely (posts
   * only store); the next tick/urgent after resume catches up. In-memory
   * only (a service restart resets it). */
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

  // --- messages -----------------------------------------------------

  /** Defensive meta parse: keep only the known typed keys. */
  function parseMeta(
    raw: string
  ): ChannelMessageMeta & { files?: ChannelFileMeta[] } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    const src = parsed as Record<string, unknown>
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
        if (!f || typeof f !== "object" || Array.isArray(f)) return []
        const file = f as Record<string, unknown>
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

  function toPublic(row: ChannelMessageRow): ChannelMessagePublic {
    const meta = parseMeta(row.meta)
    return {
      id: row.id,
      channelKey: row.channelKey,
      authorType: row.authorType as "system" | "user" | "agent",
      authorAgentId: row.authorAgentId,
      authorName: row.authorName,
      body: row.body,
      meta,
      createdAt: row.createdAt,
      files: meta.files ?? [],
    }
  }

  /** Resolve an attachment source path against the posting agent's OWN
   * workspace directory; reject anything that escapes it. Returns the
   * absolute host path + the sanitized filename. */
  function resolveAgentFile(
    agent: typeof agents.$inferSelect,
    path: string
  ): { abs: string; filename: string } {
    if (!path || path.includes("\0") || path.startsWith("/")) {
      throw new RunActionError(
        "invalid",
        `附件路径不合法：${path}（须为你自己工作目录内的相对路径）`
      )
    }
    if (!agent.challengeId) {
      throw new RunActionError("invalid", "只有解题 agent 可以发送附件")
    }
    const root = resolve(
      join(
        dataDir,
        "events",
        agent.eventId,
        "challenges",
        agent.challengeId,
        "workspace",
        "agents",
        agent.id.slice(0, 8)
      )
    )
    const candidate = resolve(root, path)
    const rel = relative(root, candidate)
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
      throw new RunActionError(
        "invalid",
        `附件路径越界：${path}（须位于你自己 agents/<id> 目录内）`
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
   * their agent id (spoof-proof attribution; callers may not override it)
   * and urgent=true collapses to a single flag. */
  function serverMeta(
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

  function insertMessage(
    key: string,
    author:
      | { type: "system"; name: string }
      | { type: "user"; name: string }
      | { type: "agent"; agentId: string; name: string },
    body: string,
    meta: ChannelMessageMeta
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

  /** Post-path key resolution: a raw derived key passes through; an agent
   * author may also use the bare friendly selectors ("#team"/"team"/
   * "orch"), mapped through the same visibility-enforced resolution as
   * readForAgent (write parity with read). user/system authors must address
   * a full key. */
  function resolvePostKey(raw: string, author: MessageAuthor): string {
    if (parseChannelKey(raw)) return raw
    if (author.type === "agent") {
      const agent = agentRow(author.agentId)
      if (agent) return resolveSelector(agent, raw)
    }
    throw new RunActionError("invalid", `非法频道键：${raw}`)
  }

  /** Copy one attachment into the challenge workspace's shared/ tree under a
   * prefix dir, deduplicating names with `-2` suffixes. Returns the shared
   * metadata entry. */
  function copyIntoShared(
    agent: typeof agents.$inferSelect,
    source: { abs: string; filename: string },
    prefix: string
  ): ChannelFileMeta {
    const workspaceRoot = deps.challengeWorkspaceRoot(
      agent.eventId,
      agent.challengeId!
    )
    const dir = join(workspaceRoot, "shared", prefix)
    mkdirSync(dir, { recursive: true })
    let target = join(dir, source.filename)
    if (targetExists(target)) {
      const ext = source.filename.includes(".")
        ? source.filename.slice(source.filename.lastIndexOf("."))
        : ""
      const stem = ext
        ? source.filename.slice(0, source.filename.length - ext.length)
        : source.filename
      for (let n = 2; ; n += 1) {
        target = join(dir, `${stem}-${n}${ext}`)
        if (!targetExists(target)) break
      }
    }
    copyFileSync(source.abs, target)
    return {
      path: ["shared", prefix, basename(target)].join("/"),
      filename: basename(target),
      size: statSync(target).size,
    }
  }

  function targetExists(path: string): boolean {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  }

  /** Post one message (the single write path): persist first (crash-safe),
   * copy attachments into shared/, advance the author's own cursor,
   * broadcast SSE, then apply the urgent/tick delivery policy. Sync — the
   * attachment copy is a filesystem copy. */
  function post(input: PostInput): ChannelMessagePublic {
    const key = resolvePostKey(input.channelKey, input.author)
    const parsed = parseChannelKey(key)!
    const body = input.body ?? ""
    if (body.length > MAX_MESSAGE_CHARS) {
      throw new RunActionError(
        "invalid",
        `消息超过 ${MAX_MESSAGE_CHARS} 字符上限（当前 ${body.length}）`
      )
    }
    // Team-channel urgency upgrade: the event's urgent-team policy makes
    // every #team post deliver immediately (meta ⚠ included) — findings reach
    // siblings now instead of at the next flush tick.
    const urgent =
      input.urgent === true ||
      (parsed.kind === "team" &&
        schedulerPolicyFor(db, eventOfKey(parsed)).urgentTeamMessages)
    // Author resolution + write permission (the 3 rules).
    const author = resolveAuthor(parsed, input.author)

    // Attachment sources resolved BEFORE the row insert (escape check);
    // copies happen right after the insert (message id irrelevant to the
    // target path — shared/from-<id8>/).
    if ((input.files?.length ?? 0) > MAX_FILES_PER_MESSAGE) {
      throw new RunActionError(
        "invalid",
        `单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`
      )
    }
    const sources: Array<{ abs: string; filename: string; size: number }> = []
    const senderAgentRow =
      author.type === "agent" ? agentRow(author.agentId) : undefined
    if (input.files?.length) {
      if (!senderAgentRow) {
        throw new RunActionError(
          "invalid",
          "workspace 附件只能由 agent 发送（用户走 multipart 上传）"
        )
      }
      for (const path of input.files) {
        const resolved = resolveAgentFile(senderAgentRow, path)
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

    const meta = serverMeta(author, input.meta, urgent)
    const message = insertMessage(key, author, body, meta)

    // shared/ copies: the file bytes freeze at post time into
    // shared/from-<agentId8>/<filename>; later workspace edits never mutate
    // the sent copy.
    if (sources.length > 0) {
      const agent = senderAgentRow!
      const files = sources.map((source) =>
        copyIntoShared(agent, source, `from-${agent.id.slice(0, 8)}`)
      )
      db.update(channelMessages)
        .set({ meta: JSON.stringify({ ...meta, files }) })
        .where(eq(channelMessages.id, message.id))
        .run()
      message.files = files
    }

    // Own posts are never the author's unread.
    if (author.type === "agent") {
      markRead(key, author.agentId, message.id)
    }

    emitChannelMessage(parsed, message)

    if (urgent) {
      deliverChannel(key, input.deliverAs ?? "steer")
    }
    return message
  }

  /** User multipart upload variant: files arrive as raw bytes and land in
   * shared/upload-<epoch>/. `urgent` defaults TRUE on this path (a user IM
   * post is rare and intended). */
  async function postWithUpload(
    input: Omit<PostInput, "files"> & {
      uploads: AttachmentInput[]
      /** Where the upload lands — derived from the channel (team → the
       * challenge workspace; dm → the target agent's challenge workspace;
       * orch → reject). */
    }
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
    const meta = serverMeta(author, input.meta, urgent)
    const message = insertMessage(parsed.raw, author, body, meta)

    if (input.uploads.length > 0) {
      // Upload targets: team → the challenge workspace; dm → the target
      // agent's challenge workspace; orch → no workspace to land in.
      let eventId: string | undefined
      let challengeId: string | undefined
      if (parsed.kind === "team") {
        const challenge = challengeRow(parsed.id)
        eventId = challenge?.eventId
        challengeId = challenge?.id
      } else if (parsed.kind === "dm") {
        const target = agentRow(parsed.id)
        eventId = target?.eventId
        challengeId = target?.challengeId ?? undefined
      }
      if (!eventId || !challengeId) {
        throw new RunActionError(
          "invalid",
          "附件上传仅支持题目频道与 solver DM"
        )
      }
      const workspaceRoot = deps.challengeWorkspaceRoot(eventId, challengeId)
      const dir = join(workspaceRoot, "shared", `upload-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      const files: ChannelFileMeta[] = []
      try {
        for (const upload of input.uploads) {
          const safe = basename(upload.filename) || "attachment"
          writeFileSync(join(dir, safe), Buffer.from(await upload.stream()))
          files.push({
            path: ["shared", basename(dir), safe].join("/"),
            filename: safe,
            size: upload.size,
          })
        }
      } catch (error) {
        // Roll the message row back — a user post that failed to land its
        // blobs must not linger (the orphan shared/upload-<ts>/ dir is swept
        // with the workspace).
        db.delete(channelMessages)
          .where(eq(channelMessages.id, message.id))
          .run()
        throw error
      }
      db.update(channelMessages)
        .set({ meta: JSON.stringify({ ...meta, files }) })
        .where(eq(channelMessages.id, message.id))
        .run()
      message.files = files
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

  /** Author name/permission resolution — the three write rules. Agent posts
   * carry an agent-signed name (`agent-a3f1` / `Scheduler`) — the same
   * string renders in the UI timeline and the steer text. */
  function resolveAuthor(
    parsed: ParsedChannelKey,
    author: MessageAuthor
  ):
    | { type: "system"; name: string }
    | { type: "user"; name: string }
    | { type: "agent"; agentId: string; name: string } {
    if (author.type === "system") {
      return { type: "system", name: author.name ?? "系统" }
    }
    if (author.type === "user") {
      return { type: "user", name: author.name ?? "用户" }
    }
    const agent = agentRow(author.agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const name = agent.name ?? `agent-${agent.id.slice(0, 8)}`
    if (parsed.kind === "team") {
      // Writers: this challenge's agents, the event's scheduler, user,
      // system. (The scheduler posts #team — its signed agent post IS the
      // announcement.)
      const sameChallenge = agent.challengeId === parsed.id
      const scheduler = schedulerAgentRow(
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
      const scheduler = schedulerAgentRow(target?.eventId ?? "")
      if (scheduler?.id !== agent.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（仅本 event 调度者可向 solver DM 发帖）"
        )
      }
    } else {
      // orch: solvers of this event (ask), user, system. The scheduler agent
      // itself never writes orch (it RECEIVES it).
      if (agent.role === "orchestrator") {
        throw new RunActionError(
          "invalid",
          "调度者不写 orch 频道（它是调度者的收件频道）"
        )
      }
      if (agent.eventId !== parsed.id) {
        throw new RunActionError(
          "invalid",
          "无权向该频道发帖（不属于此 event）"
        )
      }
    }
    return { type: "agent", agentId: agent.id, name }
  }

  // --- delivery engine ------------------------------------------------------

  /** The functional read key of an agent: solvers read under their own id;
   * the scheduler reads orch under the stable "scheduler" key. */
  function readerKeyOf(agent: typeof agents.$inferSelect): string {
    return agent.role === "orchestrator" ? SCHEDULER_READ_KEY : agent.id
  }

  /** The agent's delivery face: solver = its challenge's #team + own dm;
   * scheduler = orch. */
  function deliveryKeys(agent: typeof agents.$inferSelect): string[] {
    if (agent.role === "orchestrator") return [orchKey(agent.eventId)]
    const keys: string[] = []
    if (agent.challengeId) keys.push(teamKey(agent.challengeId))
    keys.push(dmKey(agent.id))
    return keys
  }

  /** The one push exit: collect unread across the agent's delivery face,
   * render ONE merged text (8K cap, overflow folding, ⚠ urgent marks),
   * advance cursors, lifecycle.send. Cold-wake red line: team/orch only
   * deliver on a live agent; dm may cold-reopen a terminal agent when the
   * caller is an urgent post (coldWake=true). */
  async function deliverAgentAwaited(
    agentId: string,
    opts: { coldWake?: boolean; deliverAs?: "steer" | "followUp" } = {}
  ): Promise<void> {
    const agent = agentRow(agentId)
    if (!agent) return
    if (isDeliveryPaused(agent.eventId)) return
    const live = isActive(agent)
    if (!live && !opts.coldWake) return
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
      if (parsed.kind !== "dm" && !live) continue // terminal: store only
      if (parsed.kind === "dm" && !live && !coldWake) continue
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

    const text = renderDelivery(
      deliveryTemplateBody(db),
      snapshots.map(({ label, messages }) => ({
        label,
        messages: messages.map((row) => ({
          authorName: row.authorName,
          createdAt: row.createdAt,
          body: row.body,
          urgent: isUrgent(row),
          files: parseMeta(row.meta).files ?? [],
        })),
      })),
      MAX_DELIVER_CHARS
    )
    // Scheduler deliveries carry the fleet snapshot (the digest renders
    // against delivery-time state — usually enough to decide without a
    // snapshot() round trip). Solvers never get one.
    const digest =
      agent.role === "orchestrator"
        ? (deps.renderSchedulerDigest?.(agent.eventId) ?? "")
        : ""
    const withDigest = digest ? `${text}\n\n${digest}` : text
    // Send-time liveness re-check (race guard): the entry check may have
    // raced a concurrent close — a broadcast must never land on (and so
    // reopen) a terminal agent; only a DM cold-wake may. Re-read, markRead,
    // and send form one synchronous block, so no close can interleave between
    // the check and the send landing.
    const agentNow = agentRow(agentId)
    if (!agentNow || (!isActive(agentNow) && !coldWake)) return
    for (const { key, maxId } of snapshots) {
      markRead(key, readerKey, maxId)
    }
    await deps.lifecycle().send(agentId, withDigest, opts.deliverAs ?? "steer")
  }

  function isActive(agent: typeof agents.$inferSelect): boolean {
    return isActiveAgentStatus(agent.status)
  }

  /** The channelDelivery template body for this delivery: the builtin row
   * when present (user-editable, takes effect on the next delivery), else
   * the built-in default (covers unseeded DBs). Per-delivery read — a few
   * local SQLite rows, no cache to invalidate. */
  function deliveryTemplateBody(db: Database): string {
    const row = db
      .select({ body: promptTemplates.body })
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.plugin, BUILTIN_PLUGIN),
          eq(promptTemplates.key, "channelDelivery")
        )
      )
      .get()
    return row?.body ?? DEFAULT_CHANNEL_DELIVERY_TEMPLATE
  }

  function isUrgent(row: ChannelMessageRow): boolean {
    try {
      return JSON.parse(row.meta)?.urgent === true
    } catch {
      return false
    }
  }

  /** Fire-and-forget delivery wrapper. Delivery is a trunk path (flag
   * notices / teammate messages) — a failure is logged, never swallowed. */
  function deliverAsync(
    agentId: string,
    opts: { coldWake?: boolean; deliverAs?: "steer" | "followUp" } = {}
  ): void {
    void deliverAgentAwaited(agentId, opts).catch((error) => {
      console.error("channel delivery failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Fire-and-forget delivery (onboarding sweep after spawn — a fresh
   * agent's cursor is 0, one deliver sweeps the challenge's whole #team
   * history into its first turn's tail). */
  function deliver(agentId: string): void {
    deliverAsync(agentId)
  }

  /** Urgent-post delivery trigger:
   *  - team → every live agent on the challenge (terminal: store only)
   *  - dm   → the target agent, cold-reopening a terminal agent
   *           (lifecycle.send → onResume — reopen touches ONLY the target)
   *  - orch → the event's scheduler, only if live (terminal → store; the
   *           stable "scheduler" cursor catches up on next start) */
  function deliverChannel(
    key: string,
    deliverAs: "steer" | "followUp" = "steer"
  ): void {
    const parsed = parseChannelKey(key)
    if (!parsed) return
    if (isDeliveryPaused(eventOfKey(parsed))) return
    if (parsed.kind === "team") {
      const liveAgents = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.challengeId, parsed.id),
            inArray(agents.status, LIVE_AGENT_STATUSES)
          )
        )
        .all()
      for (const { id } of liveAgents) {
        deliverAsync(id, { deliverAs })
      }
      return
    }
    if (parsed.kind === "dm") {
      deliverAsync(parsed.id, { coldWake: true, deliverAs })
      return
    }
    // orch: only a live scheduler receives pushes.
    const orch = schedulerAgentRow(parsed.id)
    if (orch && isActive(orch)) {
      deliverAsync(orch.id, { deliverAs })
    }
  }

  function eventOfKey(parsed: ParsedChannelKey): string {
    if (parsed.kind === "orch") return parsed.id
    if (parsed.kind === "team") {
      return challengeRow(parsed.id)?.eventId ?? ""
    }
    return agentRow(parsed.id)?.eventId ?? ""
  }

  // --- flush tick -----------------------------------------------------------

  let flushTimer: ReturnType<typeof setInterval> | null = null
  let nextFlushAt: number | null = null

  /** One global interval; no per-event objects, no catch-up code — messages
   * are persisted, so a missed tick's backlog settles on the next one. */
  function startFlushLoop(): void {
    if (flushTimer) return
    nextFlushAt = Date.now() + intervalMs
    flushTimer = setInterval(() => runFlushTick(), intervalMs)
  }

  /** The tick: every live agent delivers its unread backlog (one single
   * query). Hold skips the whole event. */
  function runFlushTick(): void {
    nextFlushAt = Date.now() + intervalMs
    try {
      const live = db
        .select({ id: agents.id, eventId: agents.eventId })
        .from(agents)
        .where(inArray(agents.status, LIVE_AGENT_STATUSES))
        .all()
      for (const row of live) {
        if (isDeliveryPaused(row.eventId)) continue
        deliverAsync(row.id)
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
    opts: { after?: number; limit?: number; before?: number } = {}
  ): ChannelMessageList {
    requireKey(channelKey)
    const after = opts.after ?? 0
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), 200)
    // The newest `limit` messages inside (after, before), ascending — desc +
    // reverse so a `before` page is the window immediately older than the
    // cursor, and no `before` is the channel tail.
    const bounds = [
      eq(channelMessages.channelKey, channelKey),
      gt(channelMessages.id, after),
    ]
    if (opts.before !== undefined)
      bounds.push(lt(channelMessages.id, opts.before))
    const rows = db
      .select()
      .from(channelMessages)
      .where(and(...bounds))
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
   * visibility (solver = own team + own dm + orch; scheduler = every team +
   * every dm + orch of its event). */
  function resolveSelector(
    agent: typeof agents.$inferSelect,
    selector: string
  ): string {
    const norm = selector === "team" ? "#team" : selector
    if (norm === "#team") {
      if (agent.role === "orchestrator" || !agent.challengeId) {
        throw new RunActionError(
          "invalid",
          "调度者请用 channels.list 返回的键寻址题目频道"
        )
      }
      return teamKey(agent.challengeId)
    }
    if (norm === "orch") return orchKey(agent.eventId)
    const parsed = parseChannelKey(norm)
    if (!parsed) throw new RunActionError("not_found", "Channel not found")
    if (!visibleTo(agent, parsed)) {
      throw new RunActionError("invalid", "无权读取该频道")
    }
    return norm
  }

  function visibleTo(
    agent: typeof agents.$inferSelect,
    parsed: ParsedChannelKey
  ): boolean {
    if (agent.role === "orchestrator") {
      if (parsed.kind === "orch") return agent.eventId === parsed.id
      if (parsed.kind === "team") {
        return challengeRow(parsed.id)?.eventId === agent.eventId
      }
      const target = agentRow(parsed.id)
      return target?.eventId === agent.eventId
    }
    if (parsed.kind === "team") return agent.challengeId === parsed.id
    if (parsed.kind === "dm") return agent.id === parsed.id
    return agent.eventId === parsed.id
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

  /** Live (running/idle) agents sharing a team channel — the 共享 badge. */
  function liveAgentCount(challengeId: string): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challengeId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
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
    let live: number | null = null
    if (parsed.kind === "team") {
      const challenge = challengeRow(parsed.id)
      eventId = challenge?.eventId ?? ""
      challengeId = parsed.id
      live = liveAgentCount(parsed.id)
    } else if (parsed.kind === "dm") {
      const target = agentRow(parsed.id)
      agentId = parsed.id
      eventId = target?.eventId ?? ""
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
      unread: readerKey
        ? unreadCount(`${parsed.kind}:${parsed.id}`, readerKey)
        : 0,
      lastMessageAt: last?.createdAt ?? null,
      liveAgentCount: live,
    }
  }

  /** SDK channels.list: solver = own #team + own dm + orch; scheduler =
   * every #team of its event's challenges + every dm of its event's solver
   * agents + orch. */
  function agentChannels(agentId: string): ChannelPublic[] {
    const agent = agentRow(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const readerKey = readerKeyOf(agent)
    if (agent.role === "orchestrator") {
      const out: ChannelPublic[] = []
      for (const challenge of db
        .select()
        .from(challenges)
        .where(eq(challenges.eventId, agent.eventId))
        .orderBy(asc(challenges.name))
        .all()) {
        out.push(
          channelInfo(parseChannelKey(teamKey(challenge.id))!, readerKey)
        )
      }
      for (const solver of db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.eventId, agent.eventId), eq(agents.role, "solver"))
        )
        .orderBy(asc(agents.createdAt))
        .all()) {
        out.push(channelInfo(parseChannelKey(dmKey(solver.id))!, readerKey))
      }
      out.push(channelInfo(parseChannelKey(orchKey(agent.eventId))!, readerKey))
      return out
    }
    return [
      ...(agent.challengeId
        ? [channelInfo(parseChannelKey(teamKey(agent.challengeId))!, readerKey)]
        : []),
      channelInfo(parseChannelKey(dmKey(agent.id))!, readerKey),
      channelInfo(parseChannelKey(orchKey(agent.eventId))!, readerKey),
    ]
  }

  /** The challenge's channel tree (UI 频道 tab / SDK list view): #team + one
   * DM per agent that ever attacked the challenge (agent rows are the whole
   * attempt history). No per-reader unread — UI unread is client-side
   * session state by design. */
  function challengeChannelTree(challengeId: string): ChannelPublic[] {
    if (!challengeRow(challengeId)) {
      throw new RunActionError("not_found", "Challenge not found")
    }
    const out: ChannelPublic[] = [
      channelInfo(parseChannelKey(teamKey(challengeId))!, null),
    ]
    for (const agent of db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.challengeId, challengeId))
      .orderBy(asc(agents.createdAt))
      .all()) {
      out.push(channelInfo(parseChannelKey(dmKey(agent.id))!, null))
    }
    return out
  }

  /** Simplified scheduler inbox snapshot: the orch key + unread (stable
   * scheduler cursor) + tick state + hold. */
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

  // --- explicit cleanup (no FK cascades — derived keys need sweeps) ----------

  /** Delete the messages + read cursors for the given channel keys. */
  function deleteChannelData(keys: string[]): void {
    if (keys.length === 0) return
    db.delete(channelMessages)
      .where(inArray(channelMessages.channelKey, keys))
      .run()
    db.delete(channelReads).where(inArray(channelReads.channelKey, keys)).run()
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
    for (const challenge of db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()) {
      keys.push(teamKey(challenge.id))
    }
    for (const agent of db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.eventId, eventId))
      .all()) {
      keys.push(dmKey(agent.id))
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
    // bus fan-out keys of a parsed channel (dm → agentId, orch → eventId,
    // team → eventId + challengeId)
    emitChannelsOf,
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
    challengeChannelTree,
    unreadCount,
    channelInfo,
    // hold + inbox
    setDeliveryPaused,
    isDeliveryPaused,
    inboxSnapshot,
    // cleanup
    deleteChannelData,
    cleanupAgentChannels,
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
    files: ChannelFileMeta[]
  }>
}

/** Render the merged delivery text via the channelDelivery template:
 * per-message header lines (⚠ prefix on urgent) + 📎 lines carrying the
 * shared-relative path; 8K cap with oldest-message folding. The folding
 * math stays in code (per-message size measured through the SAME template,
 * so a custom template folds accurately). Attachment CONTENT never enters
 * the text — readers open the shared path directly. */
function renderDelivery(
  body: string,
  groups: RenderGroup[],
  maxChars: number
): string {
  const ctx = (
    messages: DeliveryRenderContext["messages"],
    dropped: number
  ): DeliveryRenderContext => ({ dropped, messages })
  const messages: DeliveryRenderContext["messages"] = groups.flatMap((group) =>
    group.messages.map((message) => ({
      urgent: message.urgent,
      label: group.label,
      authorName: message.authorName,
      time: timeOf(message.createdAt),
      body: message.body.trim() || "(空)",
      files: message.files.map((file) => ({
        filename: file.filename,
        size: formatSize(file.size),
        path: file.path,
      })),
    }))
  )
  const render = (c: DeliveryRenderContext) => renderTemplateBody(body, c)
  const plain = render(ctx(messages, 0))
  if (plain.length <= maxChars) return plain
  // Over budget: keep the NEWEST messages that fit; fold the dropped count.
  // Fixed prefix (header lines) measured through the same template so a
  // custom template budgets against its own prefix.
  const prefixLen = render(ctx([], 0)).length
  const budget = maxChars - prefixLen - 120
  let used = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const size = render(ctx([messages[i]!], 0)).length - prefixLen
    if (used + size > budget) break
    used += size
    start = i
  }
  return render(ctx(messages.slice(start), start))
}

/** Default-template render (the pure/exported face — same output the
 * service produces with unedited builtin rows). */
export function renderMerged(groups: RenderGroup[]): string {
  return renderDelivery(
    DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
    groups,
    MAX_DELIVER_CHARS
  )
}
