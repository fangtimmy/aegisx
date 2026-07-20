import { count, eq, getTableColumns, inArray, max, sql } from "drizzle-orm"
import type {
  Attachment,
  Challenge as ChallengePublic,
  EventSummary,
} from "../../../shared/api"
import type { createDatabase } from "../db"
import { attachments, challenges, events, runs } from "../db/schema"
import type { RemoteTargetInfo } from "../platforms/core"
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
        solvedCount: sql<number>`coalesce(sum(case when ${challenges.remoteSolved} = 1 or exists (select 1 from ${runs} where ${runs.challengeId} = ${challenges.id} and ${runs.status} = 'completed') then 1 else 0 end), 0)`,
        lastChallengeAt: max(challenges.updatedAt),
        activeRunCount: sql<number>`coalesce((select sum(case when r.status in ('running', 'paused') then 1 else 0 end) from runs r inner join challenges rc on r.challenge_id = rc.id where rc.event_id = events.id), 0)`,
        lastRunAt: sql<
          string | null
        >`(select max(r.updated_at) from runs r inner join challenges rc on r.challenge_id = rc.id where rc.event_id = events.id)`,
      })
      .from(events)
      .leftJoin(challenges, eq(challenges.eventId, events.id))
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
    challengeAttachments: Array<{
      id: string
      challengeId: string
      originalName: string
      size: number
      sha256: string
      createdAt: string
      downloadUrl: string
    }>,
    runSummary?: { runCount: number; completedRunCount: number }
  ): ChallengePublic => {
    const runCount = Number(runSummary?.runCount ?? 0)
    const completedRunCount = Number(runSummary?.completedRunCount ?? 0)
    const { remoteSourceKey: _, remoteTargetInfo, ...publicValue } = challenge
    return {
      ...publicValue,
      remoteTargetCount: challenge.remoteTargetIgnored
        ? 0
        : challenge.remoteTargetCount,
      targets: challenge.remoteTargetIgnored
        ? []
        : parseTargetInfo(remoteTargetInfo),
      attachments: challengeAttachments,
      runCount,
      status:
        challenge.remoteSolved || completedRunCount > 0
          ? ("solved" as const)
          : runCount > 0
            ? ("in_progress" as const)
            : ("not_started" as const),
    }
  }

  const getChallenge = (challengeId: string) => {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) return undefined
    const runSummary = db
      .select({
        runCount: count(),
        completedRunCount: sql<number>`coalesce(sum(case when ${runs.status} = 'completed' then 1 else 0 end), 0)`,
      })
      .from(runs)
      .where(eq(runs.challengeId, challengeId))
      .get()
    return publicChallenge(
      challenge,
      listAttachments([challengeId]),
      runSummary
    )
  }

  const listChallengesForEvent = (eventId: string) => {
    const rows = db
      .select()
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    const ids = rows.map(({ id }) => id)
    const attachmentRows = listAttachments(ids)
    const runRows =
      ids.length === 0
        ? []
        : db
            .select({
              challengeId: runs.challengeId,
              runCount: count(),
              completedRunCount: sql<number>`coalesce(sum(case when ${runs.status} = 'completed' then 1 else 0 end), 0)`,
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
    return rows.map((challenge) =>
      publicChallenge(
        challenge,
        attachmentsByChallenge.get(challenge.id) ?? [],
        runsByChallenge.get(challenge.id)
      )
    )
  }

  return { getChallenge, getEvent, listChallengesForEvent, listEvents }
}

function parseTargetInfo(value: string): RemoteTargetInfo[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((target) =>
      typeof target === "object" &&
      target !== null &&
      "name" in target &&
      typeof target.name === "string" &&
      "services" in target &&
      Array.isArray(target.services)
        ? [
            {
              name: target.name,
              services: target.services.filter(
                (service: unknown): service is string =>
                  typeof service === "string"
              ),
            },
          ]
        : []
    )
  } catch {
    return []
  }
}
