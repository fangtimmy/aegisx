import { LIVE_AGENT_STATUSES } from "@aegisx/shared"
import type {
  ChannelMessageList,
  ChannelMessagePublic,
  ChannelPublic,
} from "@aegisx/shared/channels"
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm"

import { agents, challenges, channelMessages } from "../db/schema"
import {
  dmKey,
  orchKey,
  parseChannelKey,
  parseMeta,
  SCHEDULER_READ_KEY,
  teamKey,
  type AgentRow,
  type ChannelContext,
  type ParsedChannelKey,
} from "./channels-context"
import { RunActionError } from "./errors"

/** Default page size for timeline reads. */
const DEFAULT_PAGE = 50

/** The read/listing side of the channels: timeline pages, the SDK agent
 * read (pull = consume), visibility-enforced selector resolution, channel
 * info listings, and the attachment download target resolution. */
export function createReadsService(ctx: ChannelContext) {
  const { db } = ctx

  function listMessages(
    channelKey: string,
    opts: { after?: number; limit?: number; before?: number } = {}
  ): ChannelMessageList {
    ctx.requireKey(channelKey)
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
      .toReversed()
    const hasMore = rows.length > limit
    const shown = hasMore ? rows.slice(rows.length - limit) : rows
    return {
      items: shown.map(ctx.toPublic),
      nextAfter: shown.length > 0 ? shown[shown.length - 1].id : after,
      hasMore,
    }
  }

  /** Resolve "#team"/"team"/"orch"/a raw key for an agent, enforcing
   * visibility (solver = own team + own dm + orch; scheduler = every team +
   * every dm + orch of its event). */
  function resolveSelector(agent: AgentRow, selector: string): string {
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

  function visibleTo(agent: AgentRow, parsed: ParsedChannelKey): boolean {
    if (agent.role === "orchestrator") {
      if (parsed.kind === "orch") return agent.eventId === parsed.id
      if (parsed.kind === "team") {
        return ctx.challengeRow(parsed.id)?.eventId === agent.eventId
      }
      const target = ctx.agentRow(parsed.id)
      return target?.eventId === agent.eventId
    }
    if (parsed.kind === "team") return agent.challengeId === parsed.id
    if (parsed.kind === "dm") return agent.id === parsed.id
    return agent.eventId === parsed.id
  }

  /** SDK read: pull = read (marks the cursor). `selector` is "#team" (or
   * "team"), "orch", or a raw channel key; visibility enforced. Pages FORWARD
   * from the cursor — the OLDEST `limit` messages above `after`, so a backlog
   * larger than one page is drained across pulls instead of truncated. */
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
    const agent = ctx.agentRow(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const key = resolveSelector(agent, selector)
    const after = opts.after ?? 0
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), 200)
    const rows = db
      .select()
      .from(channelMessages)
      .where(
        and(eq(channelMessages.channelKey, key), gt(channelMessages.id, after))
      )
      .orderBy(asc(channelMessages.id))
      .limit(limit + 1)
      .all()
    const hasMore = rows.length > limit
    const shown = hasMore ? rows.slice(0, limit) : rows
    const result = {
      items: shown.map(ctx.toPublic),
      nextAfter: shown.length > 0 ? shown[shown.length - 1].id : after,
      hasMore,
    }
    const readerKey =
      agent.role === "orchestrator" ? SCHEDULER_READ_KEY : agent.id
    if (opts.markRead !== false && result.items.length > 0) {
      // Safe to jump to items[last]: the forward window makes it the
      // contiguous consumed frontier — the cursor only ever crosses messages
      // this pull actually returned.
      ctx.markRead(key, readerKey, result.items[result.items.length - 1].id)
    }
    return {
      channel: channelInfo(parseChannelKey(key)!, agentId),
      ...result,
    }
  }

  function unreadCount(key: string, readerKey: string): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelKey, key),
          gt(channelMessages.id, ctx.readCursor(key, readerKey)),
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
      const challenge = ctx.challengeRow(parsed.id)
      eventId = challenge?.eventId ?? ""
      challengeId = parsed.id
      live = liveAgentCount(parsed.id)
    } else if (parsed.kind === "dm") {
      const target = ctx.agentRow(parsed.id)
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
      label: ctx.channelLabel(parsed),
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

  /** Resolve a recorded message attachment back to the challenge workspace
   * it landed in (the UI download path): the path must match a file recorded
   * on the message — no free-form workspace reads. team → the challenge
   * workspace; dm → the target agent's; orch → the author agent's (only
   * solver agents attach, user uploads are rejected on orch). */
  function channelFileTarget(
    channelKey: string,
    messageId: number,
    path: string
  ): { eventId: string; challengeId: string; filename: string } {
    const parsed = ctx.requireKey(channelKey)
    const row = db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.id, messageId))
      .get()
    if (!row || row.channelKey !== parsed.raw) {
      throw new RunActionError("not_found", "消息不存在")
    }
    const file = parseMeta(row.meta).files?.find((f) => f.path === path)
    if (!file) throw new RunActionError("not_found", "附件不存在")
    let eventId: string | undefined
    let challengeId: string | undefined
    if (parsed.kind === "team") {
      const challenge = ctx.challengeRow(parsed.id)
      eventId = challenge?.eventId
      challengeId = challenge?.id
    } else {
      const agent =
        parsed.kind === "dm"
          ? ctx.agentRow(parsed.id)
          : row.authorAgentId
            ? ctx.agentRow(row.authorAgentId)
            : undefined
      eventId = agent?.eventId
      challengeId = agent?.challengeId ?? undefined
    }
    if (!eventId || !challengeId) {
      throw new RunActionError("not_found", "附件所属题目不存在")
    }
    return { eventId, challengeId, filename: file.filename }
  }

  /** SDK channels.list: solver = own #team + own dm + orch; scheduler =
   * every #team of its event's challenges + every dm of its event's solver
   * agents + orch. */
  function agentChannels(agentId: string): ChannelPublic[] {
    const agent = ctx.agentRow(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    const readerKey =
      agent.role === "orchestrator" ? SCHEDULER_READ_KEY : agent.id
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
    if (!ctx.challengeRow(challengeId)) {
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

  return {
    listMessages,
    resolveSelector,
    readForAgent,
    unreadCount,
    channelInfo,
    channelFileTarget,
    agentChannels,
    challengeChannelTree,
  }
}
