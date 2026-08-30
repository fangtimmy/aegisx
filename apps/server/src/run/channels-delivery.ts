import { isActiveAgentStatus, LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, asc, eq, gt, inArray } from "drizzle-orm"

import { agents, channelMessages, promptTemplates } from "../db/schema"
import { DEFAULT_CHANNEL_DELIVERY_TEMPLATE } from "../orchestration/prompt-defaults"
import { BUILTIN_PLUGIN } from "../orchestration/prompt-templates"
import {
  dmKey,
  isUrgent,
  orchKey,
  parseChannelKey,
  parseMeta,
  SCHEDULER_READ_KEY,
  teamKey,
  type AgentRow,
  type ChannelContext,
} from "./channels-context"
import { MAX_DELIVER_CHARS, renderDelivery } from "./channels-render"

function isActive(agent: AgentRow): boolean {
  return isActiveAgentStatus(agent.status)
}

/** The functional read key of an agent: solvers read under their own id;
 * the scheduler reads orch under the stable "scheduler" key. */
function readerKeyOf(agent: AgentRow): string {
  return agent.role === "orchestrator" ? SCHEDULER_READ_KEY : agent.id
}

/** The agent's delivery face: solver = its challenge's #team + own dm;
 * scheduler = orch. */
function deliveryKeys(agent: AgentRow): string[] {
  if (agent.role === "orchestrator") return [orchKey(agent.eventId)]
  const keys: string[] = []
  if (agent.challengeId) keys.push(teamKey(agent.challengeId))
  keys.push(dmKey(agent.id))
  return keys
}

/** The delivery engine: the one push exit for unread messages plus the
 * global flush tick. Cold-wake red line: team/orch only deliver on a live
 * agent; dm may cold-reopen a terminal agent when the caller is an urgent
 * post (coldWake=true). */
export function createDeliveryEngine(ctx: ChannelContext) {
  const { db, deps } = ctx

  async function deliverAgentAwaited(
    agentId: string,
    opts: { coldWake?: boolean; deliverAs?: "steer" | "followUp" } = {}
  ): Promise<void> {
    const agent = ctx.agentRow(agentId)
    if (!agent) return
    if (ctx.isDeliveryPaused(agent.eventId)) return
    const live = isActive(agent)
    if (!live && !opts.coldWake) return
    const readerKey = readerKeyOf(agent)
    const coldWake = opts.coldWake === true

    type Snapshot = {
      key: string
      label: string
      messages: (typeof channelMessages.$inferSelect)[]
      maxId: number
    }
    const snapshots: Snapshot[] = []
    for (const key of deliveryKeys(agent)) {
      const parsed = parseChannelKey(key)!
      if (parsed.kind !== "dm" && !live) continue // terminal: store only
      if (parsed.kind === "dm" && !live && !coldWake) continue
      const cursor = ctx.readCursor(key, readerKey)
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
        label: ctx.channelLabel(parsed),
        messages: rows,
        maxId: rows[rows.length - 1].id,
      })
    }
    if (snapshots.length === 0) return

    const text = renderDelivery(
      deliveryTemplateBody(),
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
    // Send-time liveness guard (race): the entry check may have raced a
    // concurrent close — while the delivery op waits on the agent lock (a
    // close mid-abort holds it), the agent can go terminal. The predicate
    // runs inside send()'s lock BEFORE any resume, so a lost race bails
    // instead of cold-reviving an aborted agent; only a DM cold-wake may.
    const delivered = await deps
      .lifecycle()
      .send(agentId, withDigest, opts.deliverAs ?? "steer", {
        assertLive: (id) => {
          const row = ctx.agentRow(id)
          return row !== undefined && (isActive(row) || coldWake)
        },
      })
    if (!delivered) return
    // Cursors advance only on an accepted delivery — a bail above leaves
    // them untouched (nothing marked read that was never delivered).
    for (const { key, maxId } of snapshots) {
      ctx.markRead(key, readerKey, maxId)
    }
  }

  /** The channelDelivery template body for this delivery: the builtin row
   * when present (user-editable, takes effect on the next delivery), else
   * the built-in default (covers unseeded DBs). Per-delivery read — a few
   * local SQLite rows, no cache to invalidate. */
  function deliveryTemplateBody(): string {
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
    if (ctx.isDeliveryPaused(ctx.eventOfKey(parsed))) return
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
    const orch = ctx.schedulerAgentRow(parsed.id)
    if (orch && isActive(orch)) {
      deliverAsync(orch.id, { deliverAs })
    }
  }

  // --- flush tick -----------------------------------------------------------

  let flushTimer: ReturnType<typeof setInterval> | null = null
  let nextFlushAt: number | null = null

  /** One global interval; no per-event objects, no catch-up code — messages
   * are persisted, so a missed tick's backlog settles on the next one. */
  function startFlushLoop(): void {
    if (flushTimer) return
    nextFlushAt = Date.now() + ctx.intervalMs
    flushTimer = setInterval(() => runFlushTick(), ctx.intervalMs)
  }

  /** The tick: every live agent delivers its unread backlog (one single
   * query). Hold skips the whole event. */
  function runFlushTick(): void {
    nextFlushAt = Date.now() + ctx.intervalMs
    try {
      const live = db
        .select({ id: agents.id, eventId: agents.eventId })
        .from(agents)
        .where(inArray(agents.status, LIVE_AGENT_STATUSES))
        .all()
      for (const row of live) {
        if (ctx.isDeliveryPaused(row.eventId)) continue
        deliverAsync(row.id)
      }
    } catch (error) {
      console.error("channel flush tick failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function stopFlushLoop(): void {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    nextFlushAt = null
  }

  return {
    deliver,
    deliverAgentAwaited,
    deliverChannel,
    runFlushTick,
    startFlushLoop,
    stopFlushLoop,
    /** Null when the flush loop is stopped (closed service). */
    nextFlushAt: () => nextFlushAt,
  }
}
