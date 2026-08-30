import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"

import { formatSize } from "@aegisx/shared"
import type {
  ChannelFileMeta,
  ChannelMessageMeta,
} from "@aegisx/shared/channels"

import { channelMessages } from "../db/schema"
import {
  parseChannelKey,
  serverMeta,
  type AgentRow,
  type AttachmentInput,
  type ChannelContext,
  type MessageAuthor,
  type ParsedChannelKey,
  type PostInput,
} from "./channels-context"
import { RunActionError } from "./errors"
import { schedulerPolicyFor } from "./scheduler-policy"

/** Server-side message body cap (characters). */
const MAX_MESSAGE_CHARS = 16_000
/** Per-file attachment cap. */
const MAX_FILE_BYTES = 64 * 1024 * 1024
/** Per-message attachment caps. */
const MAX_FILES_PER_MESSAGE = 8
const MAX_MESSAGE_TOTAL_BYTES = 128 * 1024 * 1024

function targetExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Resolve an attachment source path against the posting agent's OWN
 * workspace directory; reject anything that escapes it. Returns the
 * absolute host path + the sanitized filename. */
function resolveAgentFile(
  ctx: ChannelContext,
  agent: AgentRow,
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
      ctx.dataDir,
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

/** Copy one attachment into the challenge workspace's shared/ tree under a
 * prefix dir, deduplicating names with `-2` suffixes. Returns the shared
 * metadata entry. */
function copyIntoShared(
  ctx: ChannelContext,
  agent: AgentRow,
  source: { abs: string; filename: string },
  prefix: string
): ChannelFileMeta {
  const workspaceRoot = ctx.deps.challengeWorkspaceRoot(
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

/** The write side of the channels: post (the single write path) plus the
 * user multipart upload variant. Persist first (crash-safe), then apply the
 * urgent/tick delivery policy via the injected deliverChannel. */
export function createPostService(
  ctx: ChannelContext,
  deliverChannel: (key: string, deliverAs?: "steer" | "followUp") => void,
  resolveSelector: (agent: AgentRow, selector: string) => string
) {
  function insertMessage(
    key: string,
    author:
      | { type: "system"; name: string }
      | { type: "user"; name: string }
      | { type: "agent"; agentId: string; name: string },
    body: string,
    meta: ChannelMessageMeta & { files?: ChannelFileMeta[] }
  ) {
    const ts = ctx.deps.now()
    const inserted = ctx.db
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
    return ctx.toPublic(inserted)
  }

  /** Post-path key resolution: a raw derived key passes through; an agent
   * author may also use the bare friendly selectors ("#team"/"team"/
   * "orch"), mapped through the same visibility-enforced resolution as
   * readForAgent (write parity with read). user/system authors must address
   * a full key. */
  function resolvePostKey(raw: string, author: MessageAuthor): string {
    if (parseChannelKey(raw)) return raw
    if (author.type === "agent") {
      const agent = ctx.agentRow(author.agentId)
      if (agent) return resolveSelector(agent, raw)
    }
    throw new RunActionError("invalid", `非法频道键：${raw}`)
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
    const agent = ctx.agentRow(author.agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const name = agent.name ?? `agent-${agent.id.slice(0, 8)}`
    if (parsed.kind === "team") {
      // Writers: this challenge's agents, the event's scheduler, user,
      // system. (The scheduler posts #team — its signed agent post IS the
      // announcement.)
      const sameChallenge = agent.challengeId === parsed.id
      const scheduler = ctx.schedulerAgentRow(
        ctx.challengeRow(parsed.id)?.eventId ?? ""
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
      const target = ctx.agentRow(parsed.id)
      const scheduler = ctx.schedulerAgentRow(target?.eventId ?? "")
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

  /** Post one message (the single write path): resolve + copy attachments
   * into shared/, persist (crash-safe), advance the author's own cursor,
   * broadcast SSE, then apply the urgent/tick delivery policy. Sync — the
   * attachment copy is a filesystem copy. */
  function post(input: PostInput) {
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
        schedulerPolicyFor(ctx.db, ctx.eventOfKey(parsed)).urgentTeamMessages)
    // Author resolution + write permission (the 3 rules).
    const author = resolveAuthor(parsed, input.author)

    // Attachment sources resolved AND copied into shared/ BEFORE the row
    // insert (escape check; message id irrelevant to the target path —
    // shared/from-<id8>/), so a failed copy can't leave a stored but
    // never-broadcast ghost message behind.
    if ((input.files?.length ?? 0) > MAX_FILES_PER_MESSAGE) {
      throw new RunActionError(
        "invalid",
        `单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`
      )
    }
    const sources: Array<{ abs: string; filename: string; size: number }> = []
    const senderAgentRow =
      author.type === "agent" ? ctx.agentRow(author.agentId) : undefined
    if (input.files?.length) {
      if (!senderAgentRow) {
        throw new RunActionError(
          "invalid",
          "workspace 附件只能由 agent 发送（用户走 multipart 上传）"
        )
      }
      for (const path of input.files) {
        const resolved = resolveAgentFile(ctx, senderAgentRow, path)
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

    // shared/ copies freeze at post time into shared/from-<agentId8>/<filename>;
    // later workspace edits never mutate the sent copy.
    let files: ChannelFileMeta[] | undefined
    if (sources.length > 0) {
      const agent = senderAgentRow!
      files = sources.map((source) =>
        copyIntoShared(ctx, agent, source, `from-${agent.id.slice(0, 8)}`)
      )
    }
    const base = serverMeta(author, input.meta, urgent)
    const message = insertMessage(
      key,
      author,
      body,
      files ? { ...base, files } : base
    )

    // Own posts are never the author's unread.
    if (author.type === "agent") {
      ctx.markRead(key, author.agentId, message.id)
    }

    ctx.emitChannelMessage(parsed, message)

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
  ) {
    const parsed = ctx.requireKey(input.channelKey)
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
    const base = serverMeta(author, input.meta, urgent)

    // Upload targets resolved + blobs landed BEFORE the insert (team → the
    // challenge workspace; dm → the target agent's challenge workspace;
    // orch → no workspace to land in), so a failed write can't leave a
    // stored but never-broadcast ghost message behind. The orphan
    // shared/upload-<ts>/ dir is swept with the workspace.
    let files: ChannelFileMeta[] | undefined
    if (input.uploads.length > 0) {
      let eventId: string | undefined
      let challengeId: string | undefined
      if (parsed.kind === "team") {
        const challenge = ctx.challengeRow(parsed.id)
        eventId = challenge?.eventId
        challengeId = challenge?.id
      } else if (parsed.kind === "dm") {
        const target = ctx.agentRow(parsed.id)
        eventId = target?.eventId
        challengeId = target?.challengeId ?? undefined
      }
      if (!eventId || !challengeId) {
        throw new RunActionError(
          "invalid",
          "附件上传仅支持题目频道与 solver DM"
        )
      }
      const workspaceRoot = ctx.deps.challengeWorkspaceRoot(
        eventId,
        challengeId
      )
      const dir = join(workspaceRoot, "shared", `upload-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      files = []
      for (const upload of input.uploads) {
        const safe = basename(upload.filename) || "attachment"
        writeFileSync(join(dir, safe), Buffer.from(await upload.stream()))
        files.push({
          path: ["shared", basename(dir), safe].join("/"),
          filename: safe,
          size: upload.size,
        })
      }
    }
    const message = insertMessage(
      parsed.raw,
      author,
      body,
      files ? { ...base, files } : base
    )

    if (author.type === "agent") {
      ctx.markRead(parsed.raw, author.agentId, message.id)
    }
    ctx.emitChannelMessage(parsed, message)
    if (urgent) {
      deliverChannel(parsed.raw, input.deliverAs ?? "steer")
    }
    return message
  }

  return { post, postWithUpload }
}
