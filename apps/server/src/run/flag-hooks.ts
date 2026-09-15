import { LIVE_AGENT_STATUSES, isActiveAgentStatus } from "@aegisx/shared"
import { and, desc, eq, inArray, ne } from "drizzle-orm"

import type { Database } from "../db"
import { agents, challengeFlags } from "../db/schema"
import {
  getChallengeRemote,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { FlagAcceptOutcome } from "../platforms/flags"
import type { createPlatformService } from "../platforms/service"
import type { Clock } from "./clock"
import type { DecisionPointEngine } from "./decision-points/engine"
import { emitDomainEvent } from "./domain-events/store"
import type { DomainEventActor } from "./domain-events/store"
import type { AgentEventPoster } from "./lifecycle-reactor"
import type { NoticePublisher } from "./orch-notices"
import type { AgentQueries } from "./queries"
import type { QueueService } from "./queue"
import { type SchedulerPolicy, schedulerPolicyFor } from "./scheduler-policy"

type PlatformService = ReturnType<typeof createPlatformService>

/** Write-up wrap-up bound after a full solve: the surviving submitter's
 * deadline is pulled to this horizon (code constant; measured wrap-up p90
 * is ~2.3min, so 5min only cuts the pathological tail). */
const SOLVED_WRAPUP_MS = 5 * 60_000

export type FlagHooksDeps = {
  db: Database
  queries: AgentQueries
  clock: Clock
  now: () => string
  /** Test seam: solved write-up wrap-up bound (default SOLVED_WRAPUP_MS). */
  solvedWrapupMs?: number
  engine: DecisionPointEngine
  notices: NoticePublisher
  queue: QueueService
  poster: AgentEventPoster
  platformService: PlatformService
  /** The kernel's terminal close (sibling/submitter stops in the cleanup). */
  closeAgent(agentId: string, by: DomainEventActor): Promise<unknown>
  armDeadline(agentId: string, deadlineAt: string): void
}

/**
 * Flag hooks (L3): the control plane's reaction to platform facts. A flag
 * acceptance opens decision points, posts the policy-gated #team notices and
 * runs the full-solve cleanup; a partial submission triggers the lighter
 * chain. Tiered by outcome — "first" (the challenge's initial solve): open
 * an URGENT decision point + a #team notice (policy-gated), run the
 * full-solve cleanup under the event's policy; "extra" (a new flag value on
 * an already-solved challenge): light #team notice only; "repeat" (a
 * duplicate of an accepted value): submitter event only.
 */
export function createFlagHooks(deps: FlagHooksDeps) {
  const { db, queries, engine, notices, queue, poster, platformService } = deps

  function notifyFlagAccepted(
    challengeId: string,
    submitterAgentId?: string,
    outcome: FlagAcceptOutcome = "first"
  ): void {
    if (submitterAgentId) {
      poster(submitterAgentId, {
        type: "agent.flagAccepted",
        agentId: submitterAgentId,
      })
    }
    if (outcome === "repeat") return
    const meta = queries.getChallengeMeta(challengeId)
    if (!meta) return
    const { eventId, name } = meta
    const policy = schedulerPolicyFor(db, eventId)
    if (outcome === "extra") {
      engine.trigger(eventId, {
        kind: "flag.accepted",
        challengeName: name,
        tier: "extra",
      })
      if (policy.notifyTeamOnFlag) {
        notices.publish({
          type: "flagAccepted",
          tier: "extra",
          eventId,
          challengeId,
          challengeName: name,
          flag: latestAcceptedFlag(challengeId),
          submitterAgentId,
        })
      }
      return
    }
    engine.trigger(eventId, {
      kind: "flag.accepted",
      challengeName: name,
      tier: "first",
    })
    if (policy.notifyTeamOnFlag) {
      notices.publish({
        type: "flagAccepted",
        tier: "first",
        eventId,
        challengeId,
        challengeName: name,
        flag: latestAcceptedFlag(challengeId),
        submitterAgentId,
        stopSiblings: policy.stopSiblingsOnSolve,
      })
    }
    stopOthersOnSolved(challengeId, submitterAgentId, policy)
  }

  /** Platform-side hook: a correct-but-incomplete multi-flag submission
   * (a multi-flag partial — the challenge is NOT fully solved). ONE
   * non-urgent decision-point trigger (flag.accepted/partial) + a
   * non-urgent system post into the challenge's #team (policy-gated) + a
   * non-urgent orch notice. The submitter rides in meta so delivery can
   * skip its own notice. */
  function notifyFlagPartial(
    challengeId: string,
    message: string | null,
    submitterAgentId?: string
  ): void {
    const meta = queries.getChallengeMeta(challengeId)
    if (!meta) return
    engine.trigger(meta.eventId, {
      kind: "flag.accepted",
      challengeName: meta.name,
      tier: "partial",
    })
    if (schedulerPolicyFor(db, meta.eventId).notifyTeamOnFlag) {
      notices.publish({
        type: "flagAccepted",
        tier: "partial",
        eventId: meta.eventId,
        challengeId,
        challengeName: meta.name,
        message,
        confirmedFlags: acceptedFlagsOf(challengeId),
        submitterAgentId,
      })
    }
    notices.publish({
      type: "flagPartialProgress",
      eventId: meta.eventId,
      challengeName: meta.name,
      message,
    })
  }

  /** The challenge's most recently updated accepted flag, if any. */
  function latestAcceptedFlag(challengeId: string): string | undefined {
    return db
      .select({ flag: challengeFlags.flag })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.status, "accepted")
        )
      )
      .orderBy(desc(challengeFlags.updatedAt))
      .get()?.flag
  }

  /** The challenge's accepted flag values (the partial-solve progress list). */
  function acceptedFlagsOf(challengeId: string): string[] {
    return db
      .select({ flag: challengeFlags.flag })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.status, "accepted")
        )
      )
      .all()
      .map((f) => f.flag)
  }

  /** Full-solve cleanup (see notifyFlagAccepted), shaped by the event's
   * policy: siblings stopped / target stopped / submitter stopped are each
   * skippable; the challenge's pending queue items are always cancelled.
   * The surviving submitter gets its deadline pulled to the wrap-up bound.
   * The target stop is AWAITED before the closes land, so the slot release
   * the drainer reacts to has actually happened on the platform (no
   * capacity-rejection race with the next spawn's start_target). */
  function stopOthersOnSolved(
    challengeId: string,
    submitterAgentId: string | undefined,
    policy: SchedulerPolicy
  ): void {
    const meta = queries.getChallengeMeta(challengeId)
    if (!meta) return
    const { eventId, name } = meta
    // Live agents on the challenge to close: siblings (policy) and, in
    // evaluation mode (stopSubmitterOnSolve), the submitter itself — no
    // write-up wrap-up. Otherwise the submitter keeps its session to
    // finish via finish_run, bounded by the wrap-up deadline below.
    const stopSubmitter =
      policy.stopSubmitterOnSolve && submitterAgentId !== undefined
    const closing = policy.stopSiblingsOnSolve || stopSubmitter
    const siblings = closing
      ? db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.challengeId, challengeId),
              inArray(agents.status, LIVE_AGENT_STATUSES),
              !stopSubmitter && submitterAgentId
                ? ne(agents.id, submitterAgentId)
                : undefined
            )
          )
          .all()
      : []
    const cancelled = queue.cancelPendingForChallenge(eventId, challengeId)
    if (submitterAgentId && !stopSubmitter) {
      armSolvedWrapup(submitterAgentId)
    }
    void (async () => {
      // Orphaned platform target: the challenge is fully solved — its
      // target is no longer needed. Awaited BEFORE the closes below: their
      // terminal drains launch the next queued agent, whose start_target
      // must not race an instance that is still shutting down.
      if (
        policy.stopTargetOnSolve &&
        isTargetCapable(getChallengeRemote(db, challengeId))
      ) {
        await platformService
          .targetAction(challengeId, "stop")
          .catch(() => undefined)
      }
      // Close siblings and count the ones that actually terminalized — a
      // close can still lose a race (already closed). The notice posts once
      // the closes settle, so it never claims a stop that didn't land.
      const stopped = (
        await Promise.all(
          siblings.map((sibling) =>
            deps
              .closeAgent(sibling.id, { kind: "system", actorId: "system" })
              .then(() => 1)
              .catch(() => 0)
          )
        )
      ).reduce<number>((sum, stopped_) => sum + stopped_, 0)
      // The freed target slot may admit a queued item even when no sibling
      // closed — wake the drainer explicitly (nothing else would).
      queue.scheduleDrain()
      if (stopped > 0 || cancelled > 0) {
        notices.publish({
          type: "solveCleanup",
          eventId,
          challengeName: name,
          stopped,
          cancelled,
        })
      }
    })()
  }

  /** Pull a surviving submitter's hard deadline to the wrap-up bound so a
   * solved challenge cannot hold an agent slot indefinitely. Only ever
   * shortens — an existing earlier deadline keeps precedence. */
  function armSolvedWrapup(agentId: string): void {
    const row = queries.getAgentRow(agentId)
    if (!row || !isActiveAgentStatus(row.status)) return
    const ms = deps.solvedWrapupMs ?? SOLVED_WRAPUP_MS
    const horizon = deps.clock.now() + ms
    if (row.deadlineAt && Date.parse(row.deadlineAt) <= horizon) return
    const iso = new Date(horizon).toISOString()
    emitDomainEvent(db, {
      type: "agent.deadline_armed",
      eventId: row.eventId,
      challengeId: row.challengeId,
      agentId,
      actor: { kind: "system", actorId: "solve-cleanup" },
      payload: { deadlineAt: iso, at: deps.now() },
    })
    deps.armDeadline(agentId, iso)
  }

  return { notifyFlagAccepted, notifyFlagPartial }
}
