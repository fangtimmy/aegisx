import { count, eq, getTableColumns, inArray, max, sql } from "drizzle-orm"
import { Value } from "typebox/value"
import type {
  Attachment,
  Challenge as ChallengePublic,
  EventSummary,
  RemoteTargetInfo,
} from "../../../shared"
import type { createDatabase } from "../db"
import {
  attachments,
  challengeRemote,
  challenges,
  events,
  runs,
} from "../db/schema"
import { RemoteTargetInfoSchema } from "../lib/schemas"
import type { ChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"

type Database = ReturnType<typeof createDatabase>["db"]
type PlatformService = ReturnType<typeof createPlatformService>

export function createCatalogReader(
  db: Database,
  platformService: PlatformService
) {
  const listEvents = (eventId?: string): EventSummary[] => {
    const query = db
      .select({
        ...getTableColumns(events),
        challengeCount: count(challenges.id),
        solvedCount: sql<number>`coalesce(sum(case when ${challengeRemote.solved} = 1 or exists (select 1 from ${runs} where ${runs.challengeId} = ${challenges.id} and ${runs.status} = 'completed') then 1 else 0 end), 0)`,
        lastChallengeAt: max(challenges.updatedAt),
        activeRunCount: sql<number>`coalesce((select sum(case when r.status in ('running', 'paused') then 1 else 0 end) from runs r inner join challenges rc on r.challenge_id = rc.id where rc.event_id = events.id), 0)`,
        lastRunAt: sql<
          string | null
        >`(select max(r.updated_at) from runs r inner join challenges rc on r.challenge_id = rc.id where rc.event_id = events.id)`,
      })
      .from(events)
      .leftJoin(challenges, eq(challenges.eventId, events.id))
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
    return (eventId ? query.where(eq(events.id, eventId)) : query)
      .groupBy(events.id)
      .orderBy(events.createdAt)
      .all()
      .map(({ lastChallengeAt, activeRunCount, lastRunAt, ...event }) => {
        const lastActivityAt = [lastChallengeAt, lastRunAt].reduce<string>(
          (latest, value) => (value && value > latest ? value : latest),
          event.updatedAt
        )
        return {
          ...event,
          challengeCount: Number(event.challengeCount),
          solvedCount: Number(event.solvedCount),
          activeRunCount: Number(activeRunCount ?? 0),
          lastActivityAt,
          platform: platformService.getPublic(event.id),
        }
      })
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

  const publicChallenge = (
    challenge: typeof challenges.$inferSelect,
    remote: ChallengeRemote | null,
    challengeAttachments: Array<{
      id: string
      challengeId: string
      originalName: string
      size: number
      sha256: string
      createdAt: string
      downloadUrl: string
    }>,
    runSummary?: {
      runCount: number
      runningCount: number
      pausedCount: number
      completedCount: number
      failedCount: number
      stoppedCount: number
    }
  ): ChallengePublic => {
    const runCount = Number(runSummary?.runCount ?? 0)
    const runningCount = Number(runSummary?.runningCount ?? 0)
    const pausedCount = Number(runSummary?.pausedCount ?? 0)
    const completedCount = Number(runSummary?.completedCount ?? 0)
    const failedCount = Number(runSummary?.failedCount ?? 0)
    const stoppedCount = Number(runSummary?.stoppedCount ?? 0)
    const ignored = remote?.targetIgnored ?? false
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
      runCount,
      runStatusCounts: {
        running: runningCount,
        paused: pausedCount,
        completed: completedCount,
        failed: failedCount,
        stopped: stoppedCount,
      },
      remoteId: remote?.remoteId ?? null,
      remoteAvailable: remote ? remote.available : true,
      remoteSolved: remote?.solved ?? false,
      remoteTarget: remote?.targetSupported ?? false,
      remoteTargetIgnored: ignored,
      remoteTargetCount: ignored ? 0 : (remote?.targetCount ?? 0),
      targets: ignored ? [] : parseTargetInfo(remote?.targetInfo),
      remoteUpdatedAt: remote?.syncedAt ?? null,
      status:
        remote?.solved || completedCount > 0
          ? ("solved" as const)
          : runCount > 0
            ? ("in_progress" as const)
            : ("not_started" as const),
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
    const runSummary = db
      .select({
        runCount: count(),
        runningCount: sql<number>`coalesce(sum(case when ${runs.status} = 'running' then 1 else 0 end), 0)`,
        pausedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'paused' then 1 else 0 end), 0)`,
        completedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'completed' then 1 else 0 end), 0)`,
        failedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'failed' then 1 else 0 end), 0)`,
        stoppedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'stopped' then 1 else 0 end), 0)`,
      })
      .from(runs)
      .where(eq(runs.challengeId, challengeId))
      .get()
    return publicChallenge(
      row.challenge,
      row.remote,
      listAttachments([challengeId]),
      runSummary
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
    const runRows =
      ids.length === 0
        ? []
        : db
            .select({
              challengeId: runs.challengeId,
              runCount: count(),
              runningCount: sql<number>`coalesce(sum(case when ${runs.status} = 'running' then 1 else 0 end), 0)`,
              pausedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'paused' then 1 else 0 end), 0)`,
              completedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'completed' then 1 else 0 end), 0)`,
              failedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'failed' then 1 else 0 end), 0)`,
              stoppedCount: sql<number>`coalesce(sum(case when ${runs.status} = 'stopped' then 1 else 0 end), 0)`,
            })
            .from(runs)
            .where(inArray(runs.challengeId, ids))
            .groupBy(runs.challengeId)
            .all()
    const attachmentsByChallenge = new Map<string, typeof attachmentRows>()
    for (const attachment of attachmentRows) {
      const values = attachmentsByChallenge.get(attachment.challengeId) ?? []
      values.push(attachment)
      attachmentsByChallenge.set(attachment.challengeId, values)
    }
    const runsByChallenge = new Map(
      runRows.map((row) => [row.challengeId, row])
    )
    return rows.map(({ challenge, remote }) =>
      publicChallenge(
        challenge,
        remote,
        attachmentsByChallenge.get(challenge.id) ?? [],
        runsByChallenge.get(challenge.id)
      )
    )
  }

  return { getChallenge, getEvent, listChallengesForEvent, listEvents }
}

function parseTargetInfo(value: string | null | undefined): RemoteTargetInfo[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((target) => {
      const cleaned = Value.Clean(RemoteTargetInfoSchema, target)
      return Value.Check(RemoteTargetInfoSchema, cleaned) ? [cleaned] : []
    })
  } catch {
    return []
  }
}
