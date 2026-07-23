import { and, count, eq } from "drizzle-orm"
import type { EventStats, RunPublic, UsageSummary } from "../../../shared"
import type { createDatabase } from "../db"
import { challenges, runs, submissions } from "../db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

const emptyUsage = (): UsageSummary => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: null,
})

/**
 * Minimal event statistics for v2 (no agent_tool_calls).
 * Full analytics can be rebuilt later from messages + agent_usage.
 */
export function eventStatistics(
  db: Database,
  eventId: string,
  eventRuns: RunPublic[],
  usageByRun: Map<string, UsageSummary>
): EventStats {
  const challengeRows = db
    .select({
      id: challenges.id,
      name: challenges.name,
      category: challenges.category,
    })
    .from(challenges)
    .where(eq(challenges.eventId, eventId))
    .all()

  const terminal = eventRuns.filter((run) =>
    ["completed", "failed", "stopped"].includes(run.status)
  )
  const successful = eventRuns.filter((run) => run.status === "completed")
  let knownCost = 0
  let unknownRunCount = 0
  const usage = [...usageByRun.values()].reduce((acc, item) => {
    if (item.cost === null) unknownRunCount += 1
    else knownCost += item.cost
    return {
      input: acc.input + item.input,
      output: acc.output + item.output,
      cacheRead: acc.cacheRead + item.cacheRead,
      cacheWrite: acc.cacheWrite + item.cacheWrite,
      totalTokens: acc.totalTokens + item.totalTokens,
      cost:
        acc.cost === null || item.cost === null
          ? null
          : (acc.cost ?? 0) + item.cost,
    }
  }, emptyUsage())

  const submissionCount =
    db
      .select({ value: count() })
      .from(submissions)
      .innerJoin(runs, eq(submissions.runId, runs.id))
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .get()?.value ?? 0

  const accepted =
    db
      .select({ value: count() })
      .from(submissions)
      .innerJoin(runs, eq(submissions.runId, runs.id))
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(
        and(eq(challenges.eventId, eventId), eq(submissions.status, "accepted"))
      )
      .get()?.value ?? 0

  return {
    eventId,
    challengeCount: challengeRows.length,
    attemptedChallengeCount: new Set(eventRuns.map((r) => r.challengeId)).size,
    solvedChallengeCount: successful.length
      ? new Set(successful.map((r) => r.challengeId)).size
      : 0,
    runCount: eventRuns.length,
    terminalRunCount: terminal.length,
    successfulRunCount: successful.length,
    successRate:
      terminal.length > 0 ? successful.length / terminal.length : null,
    usage,
    cost: {
      known: knownCost,
      unknownRunCount,
    },
    duration: { medianMs: null, p90Ms: null },
    funnel: {
      totalChallenges: challengeRows.length,
      attemptedChallenges: new Set(eventRuns.map((r) => r.challengeId)).size,
      submittedChallenges: submissionCount > 0 ? 1 : 0,
      solvedChallenges: successful.length
        ? new Set(successful.map((r) => r.challengeId)).size
        : 0,
      totalSubmissions: submissionCount,
      acceptedSubmissions: accepted,
      rejectedSubmissions: Math.max(0, submissionCount - accepted),
      submittedRuns: 0,
      firstAttemptAcceptedRuns: 0,
    },
    failures: [],
    models: [],
    trend: [],
    categories: challengeRows.reduce(
      (acc, row) => {
        const category = row.category ?? "uncategorized"
        const existing = acc.find((item) => item.category === category)
        if (existing) existing.challengeCount += 1
        else
          acc.push({
            category,
            challengeCount: 1,
            attemptedCount: 0,
            solvedCount: 0,
          })
        return acc
      },
      [] as EventStats["categories"]
    ),
    outcomes: [
      {
        outcome: "successful",
        runCount: successful.length,
        averageTokens: 0,
        averageDurationMs: null,
      },
      {
        outcome: "unsuccessful",
        runCount: terminal.length - successful.length,
        averageTokens: 0,
        averageDurationMs: null,
      },
    ],
    tools: [],
    challenges: challengeRows.map((row) => {
      const runsFor = eventRuns.filter((r) => r.challengeId === row.id)
      const ok = runsFor.filter((r) => r.status === "completed")
      return {
        challengeId: row.id,
        challengeName: row.name,
        category: row.category,
        runCount: runsFor.length,
        successfulRunCount: ok.length,
        usage: emptyUsage(),
        cost: { known: 0, unknownRunCount: 0 },
        duration: { medianMs: null, p90Ms: null },
      }
    }),
    runs: eventRuns.map((run) => ({
      run,
      usage: usageByRun.get(run.id) ?? emptyUsage(),
      durationMs: null,
      successful: run.status === "completed",
    })),
  }
}
