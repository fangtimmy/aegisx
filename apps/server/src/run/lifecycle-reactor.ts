import { rmSync } from "node:fs"
import { join } from "node:path"

import { LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challenges } from "../db/schema"
import { logEvent } from "../lib/log"
import type { NOTICE_TEMPLATE_DEFAULTS } from "../orchestration/prompt-defaults"
import { renderTemplateBody } from "../orchestration/prompt-templates"
import type { EventScopePayload } from "../orchestration/types"
import {
  getChallengeRemote,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { orchKey, type ChannelService } from "./channels"
import type { DecisionPointEngine } from "./decision-points/engine"
import type { LifecycleReactor, TerminalInfo } from "./kernel"
import type { AgentQueries } from "./queries"
import type { QueueService } from "./queue"
import { schedulerPolicyFor } from "./scheduler-policy"
import { agentId8 } from "./workspace-resolver"

type PlatformService = ReturnType<typeof createPlatformService>

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

export type AgentEventPoster = (
  agentId: string,
  payload: EventScopePayload
) => void

export type AgentEventPosterDeps = {
  db: Database
  queries: AgentQueries
  /** Derived-key channel core — agent lifecycle events post into orch. */
  channels: ChannelService
  /** Whether the event's scheduler is paused (W3): paused → the
   * agent-lifecycle events are dropped before they reach the scheduler. */
  isSchedulerPaused(eventId: string): boolean
  /** Notice-template body for a lifecycle key: the stored (user-editable) row
   * when present, else the shipped default — same store as orch-notices. */
  templateBody: (key: LifecycleNoticeKey) => string
}

/**
 * Dispatch an agent lifecycle event as an orch system message (the L3 half
 * of the old agent-status event face). Only solver agents emit — the
 * scheduler observes its solvers, never itself. A paused scheduler (W3) is
 * silent: events are dropped here (the one-line gate before post). Urgent =
 * timedOut only. The payload carries the agent's `source` so the scheduler
 * can tell manual spawns apart. Consumed by the lifecycle reactor, the
 * spawn-service (started) and the flag hooks (flagAccepted).
 */
export function createAgentEventPoster(
  deps: AgentEventPosterDeps
): AgentEventPoster {
  const { db, queries, channels, templateBody } = deps

  return function postAgentEvent(agentId, payload) {
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
  }
}

export type LifecycleReactorDeps = {
  db: Database
  queries: AgentQueries
  queue: QueueService
  engine: DecisionPointEngine
  poster: AgentEventPoster
  platformService: PlatformService
  /** Host root of a challenge's workspace tree (the recycle scope). */
  challengeWorkspaceRoot(eventId: string, challengeId: string): string
}

/**
 * The L3 lifecycle reactor — the side-effect half of agent terminal/turn
 * events (moved verbatim from the old agent-status/service closures when
 * the kernel was extracted). Order is kernel contract:
 *
 *   terminal: bus.forget (kernel) → markDone → scheduleDrain →
 *             engine.onAgentTerminal → aborted-workspace recycling →
 *             target-stop policy → the finish line
 *   turn:     idle line → engine settled feed
 */
export function createLifecycleReactor(
  deps: LifecycleReactorDeps
): LifecycleReactor {
  const { db, queries, queue, engine, poster, platformService } = deps

  /** Agent went terminal: release the resources that only a live agent
   * justifies holding. An aborted/failed attempt leaves no curated
   * artifacts (a completed attempt's WRITEUP.md is kept), so its directory
   * is recycled eagerly — one long-fought challenge otherwise accumulates
   * dozens of stale trees that mislead every later spawn. The target-slot
   * fence counts a challenge as occupying a slot while it has a live agent;
   * the platform counts a running instance — release the instance when the
   * last live agent leaves, or the two views diverge and the fence keeps
   * admitting spawns the platform cannot serve. */
  function releaseChallengeResources(agentId: string): void {
    engine.onAgentTerminal(agentId)
    const row = queries.getAgentRow(agentId)
    if (!row?.challengeId) return
    const challengeId = row.challengeId
    if (row.status === "aborted" || row.status === "failed") {
      rmSync(
        join(
          deps.challengeWorkspaceRoot(row.eventId, challengeId),
          "agents",
          agentId8(agentId)
        ),
        { recursive: true, force: true }
      )
    }
    if (!schedulerPolicyFor(db, row.eventId).stopTargetOnSolve) return
    const live = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challengeId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .get()
    if (live || !isTargetCapable(getChallengeRemote(db, challengeId))) return
    void platformService
      .targetAction(challengeId, "stop")
      .catch(() => undefined)
  }

  return {
    /** Idle line first, then the engine's settled feed. */
    onTurnSettled(agentId, error) {
      poster(agentId, {
        type: "agent.idle",
        agentId,
        failed: Boolean(error),
      })
      engine.onTurnSettled(agentId, error)
    },

    /** The timedOut line (urgent) + the urgent engine trigger — solver
     * agents only (the scheduler observes its solvers, never itself). */
    onAgentTimedOut(agentId, outcome) {
      poster(agentId, { type: "agent.timedOut", agentId, outcome })
      const row = queries.getAgentRow(agentId)
      if (!row || row.role !== "solver" || !row.challengeId) return
      engine.trigger(row.eventId, {
        kind: "agent.timedOut",
        agentId,
        outcome,
      })
    },

    onAgentReopened(agentId) {
      poster(agentId, { type: "agent.reopened", agentId })
    },

    /** Queue release (markDone) → re-drain → engine feed + recycling +
     * target-stop policy → the finish line. */
    onTerminal(agentId: string, info: TerminalInfo) {
      queue.markDone(info.queueItemId, agentId)
      queue.scheduleDrain()
      releaseChallengeResources(agentId)
      if (info.event) {
        poster(agentId, {
          type: info.event,
          agentId,
          ...(info.actor ? { actor: info.actor } : {}),
        })
      }
    },

    onBootQueueReset(eventId) {
      queue.resetRunning(eventId)
    },

    onBootDrain() {
      queue.scheduleDrain()
    },
  }
}
