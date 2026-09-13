import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { challenges } from "../db/schema"
import { logEvent } from "../lib/log"
import type { NOTICE_TEMPLATE_DEFAULTS } from "../orchestration/prompt-defaults"
import { renderTemplateBody } from "../orchestration/prompt-templates"
import type { EventScopePayload } from "../orchestration/types"
import { orchKey, type ChannelService } from "./channels"
import {
  emitDomainEvent,
  actorLabel,
  type DomainEventActor,
} from "./domain-events/store"
import type { LiveBus } from "./host/live"
import type { RunPort } from "./ports"
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
   * agent justifies holding (the challenge's platform target instance) and
   * feeds the decision-point engine. */
  onAgentTerminal(agentId: string): void
  /** Decision-point engine feed (§3.6): EVERY turn settle — solver settles
   * are agent.settled triggers; the scheduler's own settle correlates its
   * open decision point. */
  onTurnSettled?(agentId: string, error: string | null): void
  /** Decision-point engine feed: a solver's hard deadline fired (the
   * urgent agent.timedOut trigger). */
  onAgentTimedOut?(agentId: string, outcome: string): void
  now: () => string
  /** Late-bound queue port (agent terminal → item done + re-drain); bound by
   * the assembly root before any agent can terminalize. */
  queue: RunPort<QueueService>
  /** Notice-template body for a lifecycle key: the stored (user-editable) row
   * when present, else the shipped default — same store as orch-notices. */
  templateBody: (key: LifecycleNoticeKey) => string
}

export type AgentStatus = ReturnType<typeof createAgentStatus>

/** The notice-template keys this module renders (defaults in
 * orchestration/prompt-defaults.ts, seeded into the same user-editable store
 * as every other system→agent notice). */
type LifecycleNoticeKey = Extract<
  keyof typeof NOTICE_TEMPLATE_DEFAULTS,
  `noticeAgent${string}`
>

/** Event display line (the orch message body): rendered from the lifecycle
 * notice templates — `tag` is the pre-derived 「challenge」agent-<id8> label,
 * the machine shape lives in meta. */
function eventBody(
  p: EventScopePayload,
  tag: string,
  templateBody: (key: LifecycleNoticeKey) => string
): string {
  switch (p.type) {
    case "agent.started":
      return renderTemplateBody(templateBody("noticeAgentStarted"), {
        tag,
        manual: p.source === "manual",
      })
    case "agent.idle":
      return renderTemplateBody(templateBody("noticeAgentIdle"), {
        tag,
        failed: Boolean(p.failed),
      })
    case "agent.flagAccepted":
      return renderTemplateBody(templateBody("noticeAgentFlagAccepted"), {
        tag,
      })
    case "agent.finished":
      return renderTemplateBody(templateBody("noticeAgentFinished"), {
        tag,
        schedulerActor: p.actor === "scheduler",
      })
    case "agent.timedOut":
      return renderTemplateBody(templateBody("noticeAgentTimedOut"), {
        tag,
        aborted: p.outcome === "aborted",
      })
    default:
      return renderTemplateBody(templateBody("noticeAgentReopened"), { tag })
  }
}

/**
 * Agent status writes + live emits + the orch event feed (v19: per-agent).
 * Turn start/settle and the terminal landing are agent.* domain facts — the
 * agents row follows from their projections; the runtime consumes a pending
 * finish_run (→ completed + summary) and arms the stall watchdog around
 * them; lifecycle events post as system messages into the event's
 * orch channel (urgent per the §五 table — timedOut only).
 */
export function createAgentStatus(deps: AgentStatusDeps) {
  const { db, queries, bus, channels, now, templateBody } = deps

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
    channels.post(
      {
        channelKey: orchKey(row.eventId),
        author: { type: "system" },
        body: eventBody({ ...payload, source }, tag, templateBody),
        meta: {
          agentId,
          eventType: payload.type,
          source,
          ...("actor" in payload ? { actor: payload.actor } : {}),
        },
        urgent: payload.type === "agent.timedOut",
      },
      { kind: "system" }
    )
    if (payload.type === "agent.timedOut") {
      deps.onAgentTimedOut?.(agentId, payload.outcome)
    }
  }

  /** Mark an agent's turn starting: the agent.turn_started fact (its
   * projection lands status running + error cleared). */
  function agentTurnStart(agentId: string, sessionId?: string): void {
    const row = queries.getAgentRow(agentId)
    if (!row) return
    emitDomainEvent(db, {
      type: "agent.turn_started",
      eventId: row.eventId,
      challengeId: row.challengeId,
      agentId,
      actor: { kind: "agent", agentId },
      payload: {
        ...(sessionId !== undefined ? { sessionId } : {}),
        at: now(),
      },
    })
    emitAgent(agentId)
  }

  /** Mark an agent's turn settled. `error` (already logged by the runtime)
   * settles the fact `failed`; a clean settle lands idle. The runtime arms
   * the stall check after this. */
  function agentTurnSettled(agentId: string, error: string | null): void {
    const ts = now()
    const row = queries.getAgentRow(agentId)
    if (row) {
      emitDomainEvent(db, {
        type: "agent.turn_settled",
        eventId: row.eventId,
        challengeId: row.challengeId,
        agentId,
        actor: { kind: "agent", agentId },
        payload: {
          outcome: error ? "failed" : "idle",
          ...(error ? { error } : {}),
          at: ts,
        },
      })
    }
    emitAgent(agentId)
    emitAgentEvent(agentId, {
      type: "agent.idle",
      agentId,
      failed: Boolean(error),
    })
    deps.onTurnSettled?.(agentId, error)
  }

  /** Terminal transition shared by finish_run (settle path), the HTTP
   * finish, close, the timeout force-abort, and the spawn-failure landing:
   * the agent.terminated fact (its projection stamps the row), then release
   * the queue item, emit, and forget the agent's live-bus snapshots
   * (context/queue/activity/running tools — a terminal agent has nothing in
   * flight to replay). The caller handles session disposal/abort before
   * this. */
  function terminalizeAgent(
    agentId: string,
    opts: {
      status: "completed" | "aborted" | "failed"
      summary?: string
      /** Spawn-failure landing's launch error (completedAt stays null). */
      error?: string
      event?: "agent.finished"
      /** Who drove the transition (user vs scheduler) — the finish event's
       * origin label. */
      actor?: "user" | "scheduler"
      /** The fact's producer (user / agent / system subsystem). */
      by?: DomainEventActor
    }
  ): void {
    const ts = now()
    const row = queries.getAgentRow(agentId)
    const by = opts.by ?? { kind: "system" as const, actorId: "run" }
    if (row) {
      emitDomainEvent(db, {
        type: "agent.terminated",
        eventId: row.eventId,
        challengeId: row.challengeId,
        agentId,
        actor: by,
        payload: {
          status: opts.status,
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
          ...(opts.error !== undefined ? { error: opts.error } : {}),
          at: ts,
          actor: actorLabel(by),
        },
      })
    }
    emitAgent(agentId)
    bus.forget([agentId])
    deps.queue.get().markDone(row?.queueItemId, agentId)
    deps.queue.get().scheduleDrain()
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
