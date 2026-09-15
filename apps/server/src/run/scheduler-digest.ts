import type { FlatSettings } from "@aegisx/shared"
import { LIVE_AGENT_STATUSES, progressOf } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  queueState,
  spawnQueue,
} from "../db/schema"
import type { SchedulerDigestContext } from "../orchestration/prompt-templates"
import { collapseToAttempts } from "../platforms/wire"
import { fmtClock } from "./channels-render"
import { fenceSnapshot } from "./fence"
import { agentUsageTotals } from "./host"
import { fmtMs } from "./kernel"

export type SchedulerDigestDeps = {
  db: Database
  getSettings: () => FlatSettings
  now: () => string
}

export type SchedulerDigest = ReturnType<typeof createSchedulerDigest>

/**
 * Fleet digest context for the decision-point payloads (schedulerDigest
 * template): caps, queue, and one line per challenge with live agents /
 * pending items plus the invested attempts / cumulative tokens (the
 * value-per-effort inputs for diversity decisions). Advisory snapshot
 * rendered at decision time — derive, don't cache. Its own module so the
 * decision-point engine binds it directly: the scheduler admin (which
 * delegates here for its reads) assembles after the engine, and a direct
 * read must not depend on assembly order.
 */
export function createSchedulerDigest(deps: SchedulerDigestDeps) {
  const { db, getSettings, now } = deps

  /** Fleet digest context for the decision-point payloads. */
  function getDigestContext(eventId: string): SchedulerDigestContext {
    const snap = fenceSnapshot(db, getSettings(), eventId)

    const liveByChallenge = new Map<string, { live: number; running: number }>()
    for (const row of db
      .select({ challengeId: agents.challengeId, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.eventId, eventId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .all()) {
      if (!row.challengeId) continue
      const entry = liveByChallenge.get(row.challengeId) ?? {
        live: 0,
        running: 0,
      }
      entry.live += 1
      if (row.status === "running") entry.running += 1
      liveByChallenge.set(row.challengeId, entry)
    }

    const pendingByChallenge = new Map<string, number>()
    let queueRunning = 0
    for (const row of db
      .select({
        challengeId: spawnQueue.challengeId,
        status: spawnQueue.status,
      })
      .from(spawnQueue)
      .where(eq(spawnQueue.eventId, eventId))
      .all()) {
      if (row.status === "running") queueRunning += 1
      if (row.status !== "pending") continue
      pendingByChallenge.set(
        row.challengeId,
        (pendingByChallenge.get(row.challengeId) ?? 0) + 1
      )
    }

    // Accepted flags per challenge, plus the newest acceptance time — the
    // yield side (count) and the stall clock (recency) both come from here.
    const acceptedByChallenge = new Map<string, number>()
    const lastFlagAtByChallenge = new Map<string, number>()
    let lastAcceptedAt = 0
    for (const row of db
      .select({
        challengeId: challengeFlags.challengeId,
        updatedAt: challengeFlags.updatedAt,
      })
      .from(challengeFlags)
      .where(eq(challengeFlags.status, "accepted"))
      .all()) {
      acceptedByChallenge.set(
        row.challengeId,
        (acceptedByChallenge.get(row.challengeId) ?? 0) + 1
      )
      const at = Date.parse(row.updatedAt)
      if (Number.isFinite(at)) {
        lastFlagAtByChallenge.set(
          row.challengeId,
          Math.max(lastFlagAtByChallenge.get(row.challengeId) ?? 0, at)
        )
        lastAcceptedAt = Math.max(lastAcceptedAt, at)
      }
    }

    // Real dispatch attempts per challenge (queue-item replays collapsed)
    // and the agents to bill each challenge's tokens to.
    const attemptsByChallenge = new Map<string, number>()
    const agentsByChallenge = new Map<string, string[]>()
    for (const row of collapseToAttempts(
      db.select().from(agents).where(eq(agents.eventId, eventId)).all()
    )) {
      if (!row.challengeId) continue
      attemptsByChallenge.set(
        row.challengeId,
        (attemptsByChallenge.get(row.challengeId) ?? 0) + 1
      )
      const ids = agentsByChallenge.get(row.challengeId) ?? []
      ids.push(row.id)
      agentsByChallenge.set(row.challengeId, ids)
    }

    const rows = db
      .select({
        id: challenges.id,
        name: challenges.name,
        points: challenges.points,
        requiredFlags: challenges.requiredFlags,
        manualSolveState: challenges.manualSolveState,
        remoteSolved: challengeRemote.solved,
        remoteId: challengeRemote.remoteId,
        remoteAvailable: challengeRemote.available,
      })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challengeRemote.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .all()

    const nowMs = Date.parse(now())
    const startedAt = startedAtFor(eventId)
    let untouched = 0
    let untouchedPoints = 0
    const digestChallenges = rows.flatMap((row) => {
      const live = liveByChallenge.get(row.id)
      const pending = pendingByChallenge.get(row.id) ?? 0
      const attempts = attemptsByChallenge.get(row.id) ?? 0
      if (!live && pending === 0) {
        // Never dispatched and not queued: absent from the per-challenge
        // lines, but still counted in the board coverage line — a challenge
        // nobody has touched must not be invisible to the scheduler.
        if (attempts === 0) {
          untouched += 1
          untouchedPoints += row.points ?? 0
        }
        return []
      }
      // Yield side: the progress machine owns the split (points × confirmed /
      // required) and the state label, so the digest cannot disagree with the
      // fence / the wire projection about what "solved" means.
      const progress = progressOf({
        accepted: acceptedByChallenge.get(row.id) ?? 0,
        requiredFlags: row.requiredFlags,
        remoteSolved: row.remoteSolved === true,
        integrated: row.remoteId !== null && row.remoteAvailable === true,
        manual: row.manualSolveState,
        points: row.points,
      })
      const solvedLabel =
        progress.state === "solved"
          ? "已解"
          : progress.state === "partial"
            ? "部分"
            : "未解"
      const lastFlagAt = lastFlagAtByChallenge.get(row.id)
      return [
        {
          name: row.name,
          points: row.points,
          perFlag: progress.perFlag,
          earned: progress.earned,
          flagProgress:
            progress.required > 1
              ? `${progress.confirmed}/${progress.required}`
              : "",
          solvedLabel,
          sinceLastFlag:
            lastFlagAt === undefined ? "" : fmtMs(nowMs - lastFlagAt),
          live: live?.live ?? 0,
          running: live?.running ?? 0,
          pending,
          attempts,
          tokens: tokensOfChallenge(agentsByChallenge.get(row.id) ?? []),
        },
      ]
    })

    const paused =
      db
        .select({ status: queueState.status })
        .from(queueState)
        .where(eq(queueState.eventId, eventId))
        .get()?.status === "paused"

    return {
      now: fmtClock(nowMs),
      elapsed: Number.isFinite(startedAt) ? fmtMs(nowMs - startedAt) : "",
      sinceLastScore: lastAcceptedAt === 0 ? "" : fmtMs(nowMs - lastAcceptedAt),
      agents: { live: snap.liveAgentCount, max: snap.maxConcurrentAgents },
      targets: {
        used: snap.activeTargetChallenges.length,
        max: snap.maxConcurrentTargets,
      },
      queue: {
        pending: [...pendingByChallenge.values()].reduce(
          (sum, count) => sum + count,
          0
        ),
        running: queueRunning,
        paused,
      },
      board: { total: rows.length, untouched, untouchedPoints },
      challenges: digestChallenges,
    }
  }

  /** Event clock anchor: when this event's scheduler agent was created — the
   * appliance's run start. No scheduler yet → NaN (no elapsed figure). */
  function startedAtFor(eventId: string): number {
    const row = db
      .select({ createdAt: agents.createdAt })
      .from(agents)
      .where(and(eq(agents.eventId, eventId), eq(agents.role, "orchestrator")))
      .get()
    const at = row ? Date.parse(row.createdAt) : Number.NaN
    return Number.isFinite(at) ? at : Number.NaN
  }

  /** Cumulative tokens spent on a challenge's agents, compact-formatted
   * ("" when nothing was spent — the digest line omits the segment). Reads
   * the usage_rollups projection (exact across archived sessions too). */
  function tokensOfChallenge(agentIds: string[]): string {
    if (agentIds.length === 0) return ""
    const totals = agentUsageTotals(db, agentIds)
    if (totals.totalTokens <= 0) return ""
    if (totals.totalTokens >= 1_000_000) {
      return `${(totals.totalTokens / 1_000_000).toFixed(1)}M`
    }
    if (totals.totalTokens >= 1_000) {
      return `${Math.round(totals.totalTokens / 1_000)}K`
    }
    return `${Math.round(totals.totalTokens)}`
  }

  return { getDigestContext }
}
