import { isActiveAgentStatus, LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, asc, eq, gt, inArray } from "drizzle-orm"

import { agents, channelMessages, promptTemplates } from "../db/schema"
import { DEFAULT_CHANNEL_DELIVERY_TEMPLATE } from "../orchestration/prompt-defaults"
import { BUILTIN_PLUGIN } from "../orchestration/prompt-templates"
import { fmtMs } from "./agent-runtime"
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
import { fmtClock, MAX_DELIVER_CHARS, renderDelivery } from "./channels-render"
import type { ClockTimer } from "./clock"
import { createTimerHub } from "./clock"

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
export function createDeliveryEngine(
  ctx: ChannelContext,
  probes: {
    /** Unread count for a reader on a channel — the heartbeat's "nothing to
     * read" test (the reads service owns cursor semantics). */
    unreadCount(channelKey: string, readerKey: string): number
  }
) {
  const { db, deps } = ctx

  // --- per-agent delivery serialization -------------------------------------
  // Deliveries for one agent run strictly one at a time. Two concurrent runs
  // both read the unread backlog before either advances the cursor, so a
  // burst would otherwise deliver the SAME messages twice. Serializing also
  // keeps the order a writer emitted. Merging a burst into one message is
  // NOT done here — the runtime folds a second steer into the first (see
  // agent-runtime send), which holds regardless of how far apart the posts
  // are and costs the first delivery no latency.
  const chains = new Map<string, Promise<void>>()
  /** Last ACCEPTED delivery per agent — the heartbeat's silence clock. */
  const lastDeliveredAt = new Map<string, number>()

  /** Chain a delivery task for one agent. An idle chain starts it
   * synchronously (an urgent post reaches its reader without an extra tick);
   * only overlapping tasks queue. */
  function enqueue(agentId: string, task: () => Promise<void>): void {
    const prior = chains.get(agentId)
    const next = (
      prior ? prior.catch(() => undefined).then(task) : task()
    ).catch((error) => {
      console.error("channel delivery failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    chains.set(agentId, next)
    void next.then(() => {
      if (chains.get(agentId) === next) chains.delete(agentId)
    })
  }

  function enqueueDelivery(
    agentId: string,
    opts: { coldWake?: boolean; deliverAs?: "steer" | "followUp" } = {}
  ): void {
    enqueue(agentId, () => deliverAgentAwaited(agentId, opts))
  }

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
            // Skip the reader's own posts AND system notices it triggered
            // (a flag acceptance must not wake the submitter itself).
            !(row.authorType === "agent" && row.authorAgentId === agentId) &&
            !(
              row.authorType === "system" &&
              parseMeta(row.meta).agentId === agentId
            )
        )
      if (rows.length === 0) continue
      snapshots.push({
        key,
        label: ctx.channelLabel(parsed),
        messages: rows,
      })
    }
    if (snapshots.length === 0) return

    const nowMs = clock.now()
    const { text, lastIds } = renderDelivery(
      deliveryTemplateBody(),
      snapshots.map(({ label, messages }) => ({
        label,
        messages: messages.map((row) => ({
          id: row.id,
          authorName: row.authorName,
          createdAt: row.createdAt,
          body: row.body,
          urgent: isUrgent(row),
          files: parseMeta(row.meta).files ?? [],
        })),
      })),
      MAX_DELIVER_CHARS,
      nowMs
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
    const delivered = await deps.send(
      agentId,
      withDigest,
      opts.deliverAs ?? "steer",
      {
        assertLive: (id) => {
          const row = ctx.agentRow(id)
          return row !== undefined && (isActive(row) || coldWake)
        },
      }
    )
    if (!delivered) return
    lastDeliveredAt.set(agentId, nowMs)
    // Cursors advance only on an accepted delivery — a bail above leaves
    // them untouched (nothing marked read that was never delivered), and
    // only past messages the render actually carried (an over-budget
    // delivery folds its NEWEST messages; they stay unread for the next
    // flush instead of being silently dropped).
    snapshots.forEach(({ key }, index) => {
      const lastId = lastIds[index]
      if (lastId !== null) ctx.markRead(key, readerKey, lastId)
    })
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

  /** Fire-and-forget delivery wrapper, serialized per agent (see
   * {@link enqueue}). Delivery is a trunk path (flag notices / teammate
   * messages) — a failure is logged, never swallowed. */
  function deliverAsync(
    agentId: string,
    opts: { coldWake?: boolean; deliverAs?: "steer" | "followUp" } = {}
  ): void {
    enqueueDelivery(agentId, opts)
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
   *           (runtime send → resume — reopen touches ONLY the target)
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

  const clock = ctx.clock
  const hub = createTimerHub(clock)
  let flushTimer: ClockTimer | null = null
  let nextFlushAt: number | null = null

  /** One global interval; no per-event objects, no catch-up code — messages
   * are persisted, so a missed tick's backlog settles on the next one. */
  function startFlushLoop(): void {
    if (flushTimer) return
    nextFlushAt = clock.now() + ctx.intervalMs
    flushTimer = hub.setInterval(() => runFlushTick(), ctx.intervalMs)
  }

  /** The tick: every live agent delivers its unread backlog (one single
   * query). Hold skips the whole event. An idle scheduler with nothing to
   * read gets a heartbeat instead — see {@link heartbeatDue}. */
  function runFlushTick(): void {
    const nowMs = clock.now()
    nextFlushAt = nowMs + ctx.intervalMs
    try {
      const live = db
        .select({
          id: agents.id,
          eventId: agents.eventId,
          role: agents.role,
          status: agents.status,
        })
        .from(agents)
        .where(inArray(agents.status, LIVE_AGENT_STATUSES))
        .all()
      for (const row of live) {
        if (ctx.isDeliveryPaused(row.eventId)) continue
        if (row.role === "orchestrator" && heartbeatDue(row, nowMs)) {
          enqueue(row.id, () => deliverHeartbeat(row.id))
          continue
        }
        deliverAsync(row.id)
      }
    } catch (error) {
      console.error("channel flush tick failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Whether this scheduler warrants a heartbeat this tick.
   *
   * A wake-up is otherwise purely event-driven, which makes a silent event
   * indistinguishable from a dead one: with an empty orch channel the
   * scheduler is never resumed, no matter how long the fleet grinds without
   * producing. The heartbeat is the floor — it only applies when the
   * scheduler is genuinely asleep and has nothing to read, so it adds no wake
   * to a busy event:
   *   - idle (a running scheduler is already awake; steering it would
   *     interrupt a turn in progress);
   *   - delivery not held;
   *   - last accepted delivery at least one tick old;
   *   - nothing unread (with unread messages the normal path covers it). */
  function heartbeatDue(
    row: { id: string; eventId: string; status: string },
    nowMs: number
  ): boolean {
    if (row.status !== "idle") return false
    const last = lastDeliveredAt.get(row.id)
    if (last !== undefined && nowMs - last < ctx.intervalMs) return false
    return probes.unreadCount(orchKey(row.eventId), SCHEDULER_READ_KEY) === 0
  }

  /** Resume the scheduler with the fleet digest and the wall clock, without
   * posting anything to the channel — the ledger stays a record of events,
   * not of wake-ups. */
  async function deliverHeartbeat(agentId: string): Promise<void> {
    const agent = ctx.agentRow(agentId)
    if (!agent || !isActive(agent)) return
    if (ctx.isDeliveryPaused(agent.eventId)) return
    const nowMs = clock.now()
    const last = lastDeliveredAt.get(agentId)
    const digest = deps.renderSchedulerDigest?.(agent.eventId) ?? ""
    const silent = last === undefined ? "启动以来" : fmtMs(nowMs - last)
    const body =
      `[当前时间] ${fmtClock(nowMs)}\n` +
      `[心跳] 距上次唤醒 ${silent}，期间无新消息 — 例行复核，不是新事件。` +
      (digest ? `\n\n${digest}` : "")
    const delivered = await deps.send(agentId, body, "steer", {
      assertLive: (id) => {
        const row = ctx.agentRow(id)
        return row !== undefined && isActive(row)
      },
    })
    if (delivered) lastDeliveredAt.set(agentId, nowMs)
  }

  function stopFlushLoop(): void {
    if (flushTimer) {
      hub.clear(flushTimer)
      flushTimer = null
    }
    // Drop the delivery chain with the loop: a closed service must not fire a
    // delivery afterwards.
    chains.clear()
    lastDeliveredAt.clear()
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
