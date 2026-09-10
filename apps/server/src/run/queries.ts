import type { AgentUsage, ChallengeFlag, MessageList } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  sessionEntries,
} from "../db/schema"
import { isTargetCapable } from "../platforms/challenge-state"
import { collapseToAttempts, toFlagPublic } from "../platforms/wire"
import { listRenderableEntries, sumUsageTotals } from "./host/session-queries"
import { type ChallengeMeta, toAgentSummary } from "./public"

export type AgentQueries = ReturnType<typeof createAgentQueries>

export function createAgentQueries(options: { db: Database }) {
  const { db } = options

  function getAgentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).get()
  }

  /** Single-challenge metadata ({eventId, name}) for run-side orchestration
   * lookups (flag notices, solve cleanup, halt). */
  function getChallengeMeta(
    challengeId: string
  ): { eventId: string; name: string } | undefined {
    return db
      .select({ eventId: challenges.eventId, name: challenges.name })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
  }

  function challengeMeta(
    challengeId: string | null
  ): ChallengeMeta | undefined {
    if (!challengeId) return undefined
    const row = db
      .select({ challenge: challenges, remote: challengeRemote })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row) return undefined
    return {
      name: row.challenge.name,
      eventId: row.challenge.eventId,
      targetSupported: isTargetCapable(row.remote ?? undefined),
    }
  }

  /** Batch challenge-meta lookup for a set of challenge ids (one query). */
  function challengeMetaMap(
    challengeIds: string[]
  ): Map<string, ChallengeMeta> {
    const map = new Map<string, ChallengeMeta>()
    if (challengeIds.length === 0) return map
    const rows = db
      .select({ challenge: challenges, remote: challengeRemote })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(inArray(challenges.id, challengeIds))
      .all()
    for (const row of rows) {
      map.set(row.challenge.id, {
        name: row.challenge.name,
        eventId: row.challenge.eventId,
        targetSupported: isTargetCapable(row.remote ?? undefined),
      })
    }
    return map
  }

  function getAgent(agentId: string): AgentSummary | undefined {
    const row = getAgentRow(agentId)
    if (!row) return undefined
    return toAgentSummary(
      row,
      row.challengeId ? challengeNameOf(row.challengeId) : ""
    )
  }

  function challengeNameOf(challengeId: string): string {
    return (
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()?.name ?? ""
    )
  }

  /** Agents of an event, optionally scoped to one challenge / role.
   * Created-order (rowid is the deterministic tiebreak within one ms).
   * Queue-item replays are collapsed to real dispatch attempts
   * ({@link collapseToAttempts}). */
  function listAgents(
    filter: {
      eventId?: string
      challengeId?: string
      role?: "solver" | "orchestrator"
    } = {}
  ): AgentSummary[] {
    const conds = []
    if (filter.eventId) conds.push(eq(agents.eventId, filter.eventId))
    if (filter.challengeId)
      conds.push(eq(agents.challengeId, filter.challengeId))
    if (filter.role) conds.push(eq(agents.role, filter.role))
    const rows = collapseToAttempts(
      db
        .select()
        .from(agents)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(agents.createdAt, sql`rowid`)
        .all()
    )
    const metas = challengeMetaMap([
      ...new Set(
        rows.map((row) => row.challengeId).filter((v): v is string => !!v)
      ),
    ])
    return rows.map((row) =>
      toAgentSummary(
        row,
        row.challengeId ? (metas.get(row.challengeId)?.name ?? "") : ""
      )
    )
  }

  /** The event's scheduler agent row (at most one per event). */
  function schedulerAgentRow(eventId: string) {
    return db
      .select()
      .from(agents)
      .where(and(eq(agents.eventId, eventId), eq(agents.role, "orchestrator")))
      .get()
  }

  /** Flags submitted by one agent (the agent overview's 结果 block). */
  function agentFlags(agentId: string): ChallengeFlag[] {
    return db
      .select()
      .from(challengeFlags)
      .where(eq(challengeFlags.agentId, agentId))
      .orderBy(asc(challengeFlags.createdAt), asc(challengeFlags.id))
      .all()
      .map(toFlagPublic)
  }

  /** Sum token usage + cost across an agent from session_entries. */
  function usageOfAgent(agentId: string): AgentUsage | undefined {
    return sumUsageTotals(db, eq(sessionEntries.agentId, agentId))
  }

  /** Event-wide token usage + cost across every agent of the event
   * (scheduler included — it burns tokens too). */
  function usageForEvent(eventId: string): AgentUsage | undefined {
    const ids = db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.eventId, eventId))
      .all()
      .map((row) => row.id)
    if (ids.length === 0) return undefined
    return sumUsageTotals(db, inArray(sessionEntries.agentId, ids))
  }

  /** Durable committed entries for one agent's ACTIVE session, paginated by
   * per-session seq (also the backtrack API's target key). `nextAfter` is
   * opaque to callers — echo it back as `after`. */
  function listMessages(
    agentId: string,
    opts: { after?: number; sessionId?: string } = {}
  ): MessageList {
    const after = opts.after ?? 0
    const agent = db
      .select({ sessionFile: agents.sessionFile })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    const sessionId = opts.sessionId ?? agent?.sessionFile ?? undefined
    if (!sessionId) return { items: [], nextAfter: after }
    return listRenderableEntries(
      db,
      and(
        eq(sessionEntries.agentId, agentId),
        eq(sessionEntries.sessionId, sessionId)
      ),
      { after }
    )
  }

  return {
    getAgentRow,
    getChallengeMeta,
    getAgent,
    listAgents,
    schedulerAgentRow,
    challengeMeta,
    challengeMetaMap,
    agentFlags,
    usageOfAgent,
    usageForEvent,
    listMessages,
  }
}
