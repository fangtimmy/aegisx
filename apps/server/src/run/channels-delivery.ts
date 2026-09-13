import { isActiveAgentStatus, LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, asc, eq, gt, inArray } from "drizzle-orm"

import { agents, channelMessages, promptTemplates } from "../db/schema"
import { DEFAULT_CHANNEL_DELIVERY_TEMPLATE } from "../orchestration/prompt-defaults"
import { BUILTIN_PLUGIN } from "../orchestration/prompt-templates"
import {
  dmKey,
  isUrgent,
  parseChannelKey,
  parseMeta,
  teamKey,
  type AgentRow,
  type ChannelContext,
} from "./channels-context"
import { MAX_DELIVER_CHARS, renderDelivery } from "./channels-render"
import type { ClockTimer } from "./clock"
import { emitDomainEvent } from "./domain-events/store"
import { createEffects } from "./effects"

function isActive(agent: AgentRow): boolean {
  return isActiveAgentStatus(agent.status)
}

/** The agent's delivery face: its challenge's #team + own dm. The scheduler
 * has NO delivery face (control-plane §3.6) — its orch channel is a ledger it
 * reads via the SDK, and the engine's decision points are its only wakes. */
function deliveryKeys(agent: AgentRow): string[] {
  const keys: string[] = []
  if (agent.challengeId) keys.push(teamKey(agent.challengeId))
  keys.push(dmKey(agent.id))
  return keys
}

/** The solver-facing delivery engine: the push exit for unread #team / dm
 * messages plus the global flush tick. Cold-wake red line: #team only
 * delivers on a live agent; dm may cold-reopen a terminal agent when the
 * caller is an urgent post (coldWake=true). */
export function createDeliveryEngine(ctx: ChannelContext) {
  const { db } = ctx

  // --- per-agent delivery serialization -------------------------------------
  // Deliveries for one agent run strictly one at a time. Two concurrent runs
  // both read the unread backlog before either advances the cursor, so a
  // burst would otherwise deliver the SAME messages twice. Serializing also
  // keeps the order a writer emitted. Merging a burst into one message is
  // NOT done here — the runtime folds a second steer into the first (see
  // agent-runtime send), which holds regardless of how far apart the posts
  // are and costs the first delivery no latency.
  const clock = ctx.clock
  const effects = createEffects(clock)

  /** Chain a delivery task for one agent (the effect layer's per-key
   * single-flight). An idle chain starts it synchronously (an urgent post
   * reaches its reader without an extra tick); only overlapping tasks
   * queue. */
  function enqueue(agentId: string, task: () => Promise<void>): void {
    effects.chain(agentId, () =>
      task().catch((error) => {
        console.error("channel delivery failed", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    )
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
    const live = isActive(agent)
    if (!live && !opts.coldWake) return
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
      const cursor = ctx.readCursor(key, agent.id)
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
      clock.now()
    )
    // Send-time liveness guard (race): the entry check may have raced a
    // concurrent close — while the delivery op waits on the agent lock (a
    // close mid-abort holds it), the agent can go terminal. The predicate
    // runs inside send()'s lock BEFORE any resume, so a lost race bails
    // instead of cold-reviving an aborted agent; only a DM cold-wake may.
    const outcome = await ctx.deps.send(
      agentId,
      text,
      opts.deliverAs ?? "steer",
      {
        assertLive: (id) => {
          const row = ctx.agentRow(id)
          return row !== undefined && (isActive(row) || coldWake)
        },
      }
    )
    if (!outcome.delivered) return
    // The accepted-delivery fact: what was pushed, how, and how big.
    emitDomainEvent(db, {
      type: "agent.delivered",
      eventId: agent.eventId,
      challengeId: agent.challengeId,
      agentId,
      actor: { kind: "system", actorId: "delivery-engine" },
      payload: { via: outcome.via, chars: outcome.chars },
    })
    // Cursors advance only on an accepted delivery — a bail above leaves
    // them untouched (nothing marked read that was never delivered), and
    // only past messages the render actually carried (an over-budget
    // delivery folds its NEWEST messages; they stay unread for the next
    // flush instead of being silently dropped).
    snapshots.forEach(({ key }, index) => {
      const lastId = lastIds[index]
      if (lastId !== null) ctx.markRead(key, agent.id, lastId)
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

  /** Urgent-post delivery trigger (SOLVERS only — the scheduler is woken by
   * the decision-point engine, never by deliveries):
   *  - team → every live agent on the challenge (terminal: store only)
   *  - dm   → the target solver, cold-reopening a terminal agent (runtime
   *           send → resume — reopen touches ONLY the target); a dm to the
   *           scheduler agent stores unread for its SDK reads. */
  function deliverChannel(
    key: string,
    deliverAs: "steer" | "followUp" = "steer"
  ): void {
    const parsed = parseChannelKey(key)
    if (!parsed) return
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
      const target = ctx.agentRow(parsed.id)
      if (!target || target.role === "orchestrator") return
      deliverAsync(parsed.id, { coldWake: true, deliverAs })
    }
    // orch: ledger only — no delivery face.
  }

  // --- flush tick -----------------------------------------------------------

  let flushTimer: ClockTimer | null = null

  /** One global interval; no per-event objects, no catch-up code — messages
   * are persisted, so a missed tick's backlog settles on the next one. */
  function startFlushLoop(): void {
    if (flushTimer) return
    flushTimer = effects.every(ctx.intervalMs, runFlushTick)
  }

  /** The tick: every live SOLVER delivers its unread backlog (one single
   * query). Orchestrators are skipped — their unread orch content rides the
   * decision-point engine's triggers, never a delivery. */
  function runFlushTick(): void {
    try {
      const live = db
        .select({
          id: agents.id,
          role: agents.role,
        })
        .from(agents)
        .where(inArray(agents.status, LIVE_AGENT_STATUSES))
        .all()
      for (const row of live) {
        if (row.role === "orchestrator") continue
        deliverAsync(row.id)
      }
    } catch (error) {
      console.error("channel flush tick failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function stopFlushLoop(): void {
    // The flush interval and the delivery chains drop with the loop: a
    // closed service must not fire a delivery afterwards.
    effects.dispose()
    flushTimer = null
  }

  return {
    deliver,
    deliverAgentAwaited,
    deliverChannel,
    runFlushTick,
    startFlushLoop,
    stopFlushLoop,
  }
}
