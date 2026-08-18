import { eq } from "drizzle-orm"

import type { LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, challenges } from "../db/schema"
import type { EventScopePayload } from "../orchestration/types"
import { orchKey, type ChannelService } from "./channels"
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
  /** Agent turn settled idle/failed: arms the stall watchdog (solver only). */
  onAgentSettled(agentId: string): void
  now(): string
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  /** Late-bound queue (agent terminal → item done + re-drain). */
  queue(): QueueService | undefined
}

export type AgentStatus = ReturnType<typeof createAgentStatus>

/**
 * Agent status writes + live emits + the orch event feed (v19: per-agent).
 * Turn start/settle maintain the agent row; settle consumes a pending
 * finish_run (→ completed + summary) and arms the stall watchdog; lifecycle
 * events post as system messages into the event's orch channel (urgent per
 * the §五 table — timedOut only).
 */
export function createAgentStatus(deps: AgentStatusDeps) {
  const { db, queries, bus, channels, now, updateAgent } = deps

  function emitAgent(agentId: string) {
    const agent = queries.getAgent(agentId)
    if (agent) bus.emit(agentId, { type: "agent.updated", agent })
  }

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
        return `${tag}已完成`
      case "agent.timedOut":
        return p.outcome === "aborted"
          ? `${tag}超时（已强制终止）`
          : `${tag}超时（已中止，agent 空闲）`
      case "agent.reopened":
        return `${tag}已重开`
    }
  }

  /** Dispatch an agent lifecycle event as an orch system message. Only
   * solver agents emit — the scheduler observes its solvers, never itself.
   * A paused scheduler (W3) is silent: events are dropped here (the
   * one-line gate before post). Urgent = timedOut only. The payload carries
   * the agent's `source` so the scheduler can tell manual spawns apart. */
  function emitAgentEvent(agentId: string, payload: EventScopePayload): void {
    const row = queries.getAgentRow(agentId)
    if (!row || row.role !== "solver" || !row.challengeId) return
    if (deps.isSchedulerPaused(row.eventId)) return
    const challengeName = db
      .select({ name: challenges.name })
      .from(challenges)
      .where(eq(challenges.id, row.challengeId))
      .get()?.name
    const agentTag = `agent-${agentId.slice(0, 8)}`
    const tag = challengeName ? `「${challengeName}」${agentTag}` : agentTag
    const source = row.source as "manual" | "scheduler"
    channels.post({
      channelKey: orchKey(row.eventId),
      author: { type: "system" },
      body: eventName({ ...payload, source }, tag),
      meta: {
        agentId,
        eventType: payload.type,
        source,
      },
      urgent: payload.type === "agent.timedOut",
    })
  }

  /** Mark an agent's turn starting. */
  function agentTurnStart(agentId: string): void {
    updateAgent(agentId, { status: "running", error: null, updatedAt: now() })
    emitAgent(agentId)
  }

  /** Mark an agent's turn settled. `error` (already logged by the lifecycle
   * core) sends the agent to `failed`; a clean settle lands idle. */
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
    deps.onAgentSettled(agentId)
  }

  /** Terminal transition shared by finish_run (settle path), the HTTP
   * finish, close, and the timeout force-abort: stamp the row, release the
   * queue item, emit. The caller handles session disposal/abort before
   * this. */
  function terminalizeAgent(
    agentId: string,
    opts: {
      status: "completed" | "aborted" | "failed"
      summary?: string
      event?: "agent.finished"
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
    const row = queries.getAgentRow(agentId)
    deps.queue()?.markDone(row?.queueItemId, agentId)
    deps.queue()?.scheduleDrain()
    if (opts.event) emitAgentEvent(agentId, { type: opts.event, agentId })
  }

  return {
    emitAgent,
    emitAgentEvent,
    agentTurnStart,
    agentTurnSettled,
    terminalizeAgent,
  }
}
