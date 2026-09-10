import type {
  AgentStatus,
  Attachment,
  Challenge as ChallengePublic,
  ChallengeFlag,
  ChallengeSolved,
  EventSummary,
  RemoteTargetInfo,
} from "@aegisx/shared"
import { progressOf } from "@aegisx/shared"
import { asc, count, eq, getTableColumns, inArray, max, sql } from "drizzle-orm"
import { Value } from "typebox/value"

import type { Database } from "../db"
import {
  agents,
  attachments,
  challengeFlags,
  challengeRemote,
  challenges,
  events,
} from "../db/schema"
import { parseJson } from "../lib/guards"
import { RemoteTargetInfoSchema } from "../lib/schemas"
import {
  isPlatformIntegrated,
  solvedChallengeSql,
  type ChallengeRemote,
} from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { collapseToAttempts, toFlagPublic } from "../platforms/wire"

type PlatformService = ReturnType<typeof createPlatformService>

/** Per-status agent counts for a challenge (the Challenge wire's
 * agentStatusCounts). Solver agents only (challengeId scope excludes the
 * scheduler by construction). */
type AgentStatusSummary = {
  agentCount: number
  counts: Partial<Record<AgentStatus, number>>
}

function agentStatusSummaryOf(
  rows: Array<{ status: AgentStatus }>
): AgentStatusSummary {
  const counts: Partial<Record<AgentStatus, number>> = {}
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1
  }
  return { agentCount: rows.length, counts }
}

export function createCatalogReader(
  db: Database,
  platformService: PlatformService
) {
  const listEvents = (eventId?: string): EventSummary[] => {
    const query = db
      .select({
        ...getTableColumns(events),
        challengeCount: count(challenges.id),
        solvedCount: sql<number>`coalesce(sum(case when ${solvedChallengeSql} then 1 else 0 end), 0)`,
        lastChallengeAt: max(challenges.updatedAt),
        activeAgentCount: sql<number>`coalesce((select sum(case when a.status in ('running', 'idle') then 1 else 0 end) from agents a where a.event_id = events.id), 0)`,
        lastAgentAt: sql<
          string | null
        >`(select max(a.updated_at) from agents a where a.event_id = events.id)`,
      })
      .from(events)
      .leftJoin(challenges, eq(challenges.eventId, events.id))
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
    const rows = (eventId ? query.where(eq(events.id, eventId)) : query)
      .groupBy(events.id)
      .orderBy(events.createdAt)
      .all()
    const platforms = platformService.getPublicMany(rows.map((row) => row.id))
    return rows.map(
      ({ lastChallengeAt, activeAgentCount, lastAgentAt, ...event }) => {
        const lastActivityAt = [lastChallengeAt, lastAgentAt].reduce<string>(
          (latest, value) => (value && value > latest ? value : latest),
          event.updatedAt
        )
        return {
          ...event,
          challengeCount: event.challengeCount,
          solvedCount: event.solvedCount,
          activeAgentCount: activeAgentCount ?? 0,
          lastActivityAt,
          platform: platforms.get(event.id) ?? null,
        }
      }
    )
  }

  const getEvent = (eventId: string) => listEvents(eventId)[0]

  const listAttachments = (challengeIds: string[]): Attachment[] => {
    if (challengeIds.length === 0) return []
    return db
      .select({
        id: attachments.id,
        challengeId: attachments.challengeId,
        originalName: attachments.originalName,
        size: attachments.size,
        sha256: attachments.sha256,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(inArray(attachments.challengeId, challengeIds))
      .all()
      .map((attachment) => ({
        ...attachment,
        downloadUrl: `/api/attachments/${attachment.id}`,
      }))
  }

  const listFlagsFor = (challengeIds: string[]): ChallengeFlag[] => {
    if (challengeIds.length === 0) return []
    return db
      .select()
      .from(challengeFlags)
      .where(inArray(challengeFlags.challengeId, challengeIds))
      .orderBy(asc(challengeFlags.createdAt), asc(challengeFlags.id))
      .all()
      .map(toFlagPublic)
  }

  const publicChallenge = (
    challenge: typeof challenges.$inferSelect,
    remote: ChallengeRemote | null,
    challengeAttachments: Attachment[],
    flags: ChallengeFlag[],
    agentSummary?: AgentStatusSummary
  ): ChallengePublic => {
    const ignored = remote?.targetIgnored ?? false
    // One rule, one place. `progress` is the state machine's verdict; the
    // `solved` dimensions are projections of the same inputs, with `local` =
    // what the local flag record ALONE proves (remote verdict and manual
    // override nulled) — on a platform-integrated challenge still owing flags
    // that is `partial`, never `solved`, so a 1/N chain cannot read as done.
    const integrated = isPlatformIntegrated(remote)
    const acceptedCount = flags.filter(
      (flag) => flag.status === "accepted"
    ).length
    const progress = progressOf({
      accepted: acceptedCount,
      requiredFlags: challenge.requiredFlags,
      remoteSolved: remote?.solved === true,
      integrated,
      manual: challenge.manualSolveState,
      points: challenge.points,
    })
    const solved: ChallengeSolved = {
      local: progressOf({
        accepted: acceptedCount,
        requiredFlags: challenge.requiredFlags,
        remoteSolved: false,
        integrated,
        manual: "unsolved",
      }).state,
      manual: challenge.manualSolveState,
      remote: remote?.solved ? "solved" : "unsolved",
    }
    return {
      id: challenge.id,
      eventId: challenge.eventId,
      name: challenge.name,
      description: challenge.description,
      category: challenge.category,
      points: challenge.points,
      createdAt: challenge.createdAt,
      updatedAt: challenge.updatedAt,
      attachments: challengeAttachments,
      flags,
      solved,
      progress,
      agentCount: agentSummary?.agentCount ?? 0,
      agentStatusCounts: agentSummary?.counts ?? {},
      remoteId: remote?.remoteId ?? null,
      remoteAvailable: remote ? remote.available : true,
      remoteTarget: remote?.targetSupported ?? false,
      remoteTargetIgnored: ignored,
      remoteTargetCount: ignored ? 0 : (remote?.targetCount ?? 0),
      targets: ignored ? [] : parseTargetInfo(remote?.targetInfo),
      remoteUpdatedAt: remote?.syncedAt ?? null,
    }
  }

  const getChallenge = (challengeId: string) => {
    const row = db
      .select({ challenge: challenges, remote: challengeRemote })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row) return undefined
    const agentRows = collapseToAttempts(
      db.select().from(agents).where(eq(agents.challengeId, challengeId)).all()
    )
    return publicChallenge(
      row.challenge,
      row.remote,
      listAttachments([challengeId]),
      listFlagsFor([challengeId]),
      agentStatusSummaryOf(agentRows)
    )
  }

  const listChallengesForEvent = (eventId: string) => {
    const rows = db
      .select({ challenge: challenges, remote: challengeRemote })
      .from(challenges)
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(challenges.eventId, eventId))
      .all()
    const ids = rows.map(({ challenge }) => challenge.id)
    const attachmentRows = listAttachments(ids)
    const flagRows = listFlagsFor(ids)
    const agentRows =
      ids.length === 0
        ? []
        : collapseToAttempts(
            db
              .select()
              .from(agents)
              .where(inArray(agents.challengeId, ids))
              .all()
          )
    const attachmentsByChallenge = new Map<string, typeof attachmentRows>()
    for (const attachment of attachmentRows) {
      const values = attachmentsByChallenge.get(attachment.challengeId) ?? []
      values.push(attachment)
      attachmentsByChallenge.set(attachment.challengeId, values)
    }
    const flagsByChallenge = new Map<string, ChallengeFlag[]>()
    for (const flag of flagRows) {
      const values = flagsByChallenge.get(flag.challengeId) ?? []
      values.push(flag)
      flagsByChallenge.set(flag.challengeId, values)
    }
    const agentsByChallenge = new Map<string, Array<{ status: AgentStatus }>>()
    for (const agent of agentRows) {
      if (!agent.challengeId) continue
      const values = agentsByChallenge.get(agent.challengeId) ?? []
      values.push(agent)
      agentsByChallenge.set(agent.challengeId, values)
    }
    return rows.map(({ challenge, remote }) =>
      publicChallenge(
        challenge,
        remote,
        attachmentsByChallenge.get(challenge.id) ?? [],
        flagsByChallenge.get(challenge.id) ?? [],
        agentStatusSummaryOf(agentsByChallenge.get(challenge.id) ?? [])
      )
    )
  }

  return { getChallenge, getEvent, listChallengesForEvent, listEvents }
}

function parseTargetInfo(value: string | null | undefined): RemoteTargetInfo[] {
  if (!value) return []
  try {
    const parsed = parseJson<unknown>(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((target) => {
      const cleaned = Value.Clean(RemoteTargetInfoSchema, target)
      return Value.Check(RemoteTargetInfoSchema, cleaned) ? [cleaned] : []
    })
  } catch {
    return []
  }
}
