import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challenges } from "../db/schema"
import { logEvent } from "../lib/log"
import type { EventScopePayload } from "../orchestration/types"
import { orchKey, type ChannelService } from "./channels"
import type { LiveBus } from "./host/live"
import type { AgentQueries } from "./queries"
import type { QueueService } from "./queue"

export type AgentStatusDeps = {
  db: Database
  queries: AgentQueries
  bus: LiveBus
  /** Derived-key channel core — agent lifecycle events post into orch. */
  channels: ChannelService
  /** Whether the event's scheduler is paused (W3): paused → the
   * agent-lifecycle events are dropped before they reach the scheduler. */
  isSchedulerPaused(eventId: string): boolean
  /** Agent went terminal: the caller releases resources that only a live
   * agent justifies holding (the challenge's platform target instance). */
  onAgentTerminal(agentId: string): void
  now: () => string
  updateAgent: (
    agentId: string,
    patch: Partial<typeof agents.$inferInsert>
  ) => void
  /** Late-bound queue (agent terminal → item done + re-drain). */
  queue(): QueueService | undefined
}

export type AgentStatus = ReturnType<typeof createAgentStatus>

/** Event display line (the orch message body): the agent's challenge name
 * + the agent label + a human verb — the machine shape lives in meta. */
function eventName(p: EventScopePayload, tag: string): string {
  switch (p.type) {
    case "agent.started":
      return `${tag}已启动${p.source === "manual" ? "（手动）" : ""}`
    case "agent.idle":
      return `${tag}已空闲${p.failed ? "（失败）" : ""}`
    case "agent.flagAccepted":
      return `${tag}flag 已接受`
    case "agent.finished":
      return `${tag}已完成${p.actor === "scheduler" ? "（调度者）" : ""}`
    case "agent.timedOut":
      return p.outcome === "aborted"
        ? `${tag}超时（已强制终止）`
        : `${tag}超时（已中止，agent 空闲）`
    case "agent.reopened":
    default:
      return `${tag}已重开`
  }
}

/**
 * Agent status writes + live emits + the orch event feed (v19: per-agent).
 * Turn start/settle maintain the agent row; the runtime consumes a pending
 * finish_run (→ completed + summary) and arms the stall watchdog around
 * these writes; lifecycle events post as system messages into the event's
 * orch channel (urgent per the §五 table — timedOut only).
 */
export function createAgentStatus(deps: AgentStatusDeps) {
  const { db, queries, bus, channels, now, updateAgent } = deps

  function emitAgent(agentId: string) {
    const agent = queries.getAgent(agentId)
    if (agent) bus.emit(agentId, { type: "agent.updated", agent })
  }

  /** Dispatch an agent lifecycle event as an orch system message. Only
   * solver agents emit — the scheduler observes its solvers, never itself.
   * A paused scheduler (W3) is silent: events are dropped here (the
   * one-line gate before post). Urgent = timedOut only. The payload carries
   * the agent's `source` so the scheduler can tell manual spawns apart. */
  function emitAgentEvent(agentId: string, payload: EventScopePayload): void {
    const row = queries.getAgentRow(agentId)
    if (!row || row.role !== "solver" || !row.challengeId) return
    const challengeName = db
      .select({ name: challenges.name })
      .from(challenges)
      .where(eq(challenges.id, row.challengeId))
      .get()?.name
    const agentTag = `agent-${agentId.slice(0, 8)}`
    const tag = challengeName ? `「${challengeName}」${agentTag}` : agentTag
    const source = row.source
    // Console timeline: every solver lifecycle event except the per-turn
    // idle — logged before the paused gate so the run history stays complete
    // while the scheduler itself stays silent.
    if (payload.type !== "agent.idle") {
      logEvent("run", payload.type, {
        ...(challengeName ? { challenge: challengeName } : {}),
        agent: agentTag,
        source,
        ...("actor" in payload ? { actor: payload.actor } : {}),
        ...("outcome" in payload ? { outcome: payload.outcome } : {}),
        ...((payload.type === "agent.finished" ||
          payload.type === "agent.timedOut") &&
        row.startedAt
          ? {
              durSec: Math.round(
                (Date.now() - Date.parse(row.startedAt)) / 1000
              ),
            }
          : {}),
      })
    }
    if (deps.isSchedulerPaused(row.eventId)) return
    channels.post({
      channelKey: orchKey(row.eventId),
      author: { type: "system" },
      body: eventName({ ...payload, source }, tag),
      meta: {
        agentId,
        eventType: payload.type,
        source,
        ...("actor" in payload ? { actor: payload.actor } : {}),
      },
      urgent: payload.type === "agent.timedOut",
    })
  }

  /** Mark an agent's turn starting. */
  function agentTurnStart(agentId: string): void {
    updateAgent(agentId, { status: "running", error: null, updatedAt: now() })
    emitAgent(agentId)
  }

  /** Mark an agent's turn settled. `error` (already logged by the runtime)
   * sends the agent to `failed`; a clean settle lands idle. The runtime arms
   * the stall check after this. */
  function agentTurnSettled(agentId: string, error: string | null): void {
    const ts = now()
    updateAgent(agentId, {
      status: error ? "failed" : "idle",
      ...(error ? { error } : {}),
      updatedAt: ts,
    })
    emitAgent(agentId)
    emitAgentEvent(agentId, {
      type: "agent.idle",
      agentId,
      failed: Boolean(error),
    })
  }

  /** Terminal transition shared by finish_run (settle path), the HTTP
   * finish, close, the timeout force-abort, and the spawn-failure landing:
   * stamp the row, release the queue item, emit, and forget the agent's
   * live-bus snapshots (context/queue/activity/running tools — a terminal
   * agent has nothing in flight to replay). The caller handles session
   * disposal/abort before this. */
  function terminalizeAgent(
    agentId: string,
    opts: {
      status: "completed" | "aborted" | "failed"
      summary?: string
      event?: "agent.finished"
      /** Who drove the transition (user vs scheduler) — the finish event's
       * origin label. */
      actor?: "user" | "scheduler"
    }
  ): void {
    const ts = now()
    const patch: Partial<typeof agents.$inferInsert> = {
      status: opts.status,
      updatedAt: ts,
      completedAt: ts,
    }
    if (opts.summary !== undefined) patch.summary = opts.summary
    updateAgent(agentId, patch)
    emitAgent(agentId)
    bus.forget([agentId])
    const row = queries.getAgentRow(agentId)
    deps.queue()?.markDone(row?.queueItemId, agentId)
    deps.queue()?.scheduleDrain()
    deps.onAgentTerminal(agentId)
    if (opts.event) {
      emitAgentEvent(agentId, {
        type: opts.event,
        agentId,
        ...(opts.actor ? { actor: opts.actor } : {}),
      })
    }
  }

  return {
    emitAgent,
    emitAgentEvent,
    agentTurnStart,
    agentTurnSettled,
    terminalizeAgent,
  }
}
