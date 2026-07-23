import { asc, eq } from "drizzle-orm"
import type {
  EventCostSummary,
  EventDurationSummary,
  EventStats,
  RunPublic,
  UsageSummary,
} from "../../../shared"
import { sumUsage } from "../agent/usage"
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

/** D1: successful run = terminal completed with a flag. */
export function isSuccessfulRun(run: RunPublic): boolean {
  return run.status === "completed" && Boolean(run.flag || run.hasFlag)
}

function isTerminal(run: RunPublic): boolean {
  return ["completed", "failed", "stopped"].includes(run.status)
}

function durationMs(run: RunPublic): number | null {
  if (!run.startedAt || !run.completedAt) return null
  const start = Date.parse(run.startedAt)
  const end = Date.parse(run.completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null
  }
  return end - start
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  )
  return sorted[index] ?? null
}

function durationSummary(values: Array<number | null>): EventDurationSummary {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  return {
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function averageNullable(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null)
  if (known.length === 0) return null
  return average(known)
}

function costSummary(items: UsageSummary[]): EventCostSummary {
  let known = 0
  let unknownRunCount = 0
  for (const item of items) {
    if (item.cost === null) unknownRunCount += 1
    else known += item.cost
  }
  return { known, unknownRunCount }
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function failureReason(run: RunPublic): string {
  if (run.status === "stopped") return "stopped"
  if (run.status === "failed") return run.error?.trim() || "failed"
  if (run.status === "completed" && !isSuccessfulRun(run)) {
    return "completed_without_flag"
  }
  return run.error?.trim() || run.status
}

/**
 * Event statistics from runs + submissions + pre-aggregated usage.
 * tools dimension is intentionally empty (no agent_tool_calls in v2).
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

  const submissionRows = db
    .select({
      runId: submissions.runId,
      challengeId: runs.challengeId,
      status: submissions.status,
      createdAt: submissions.createdAt,
    })
    .from(submissions)
    .innerJoin(runs, eq(submissions.runId, runs.id))
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .where(eq(challenges.eventId, eventId))
    .orderBy(asc(submissions.createdAt))
    .all()

  const terminal = eventRuns.filter(isTerminal)
  const successful = eventRuns.filter(isSuccessfulRun)
  const usageList = eventRuns.map(
    (run) => usageByRun.get(run.id) ?? emptyUsage()
  )
  const usage = sumUsage(usageList)
  const cost = costSummary(usageList)
  const durations = eventRuns.map(durationMs)
  const duration = durationSummary(durations)

  const attemptedChallengeIds = new Set(eventRuns.map((r) => r.challengeId))
  const solvedChallengeIds = new Set(successful.map((r) => r.challengeId))
  const submittedChallengeIds = new Set(
    submissionRows.map((row) => row.challengeId)
  )
  const submittedRunIds = new Set(submissionRows.map((row) => row.runId))
  const accepted = submissionRows.filter((row) => row.status === "accepted")
  const rejected = submissionRows.filter((row) => row.status === "rejected")

  // First submission per run that is accepted counts as first-attempt accepted.
  const firstByRun = new Map<string, (typeof submissionRows)[number]>()
  for (const row of submissionRows) {
    if (!firstByRun.has(row.runId)) firstByRun.set(row.runId, row)
  }
  let firstAttemptAcceptedRuns = 0
  for (const row of firstByRun.values()) {
    if (row.status === "accepted") firstAttemptAcceptedRuns += 1
  }

  const runRows: EventStats["runs"] = eventRuns.map((run) => ({
    run,
    usage: usageByRun.get(run.id) ?? emptyUsage(),
    durationMs: durationMs(run),
    successful: isSuccessfulRun(run),
  }))

  // failures
  const failureMap = new Map<
    string,
    { reason: string; runCount: number; usages: UsageSummary[] }
  >()
  for (const item of runRows) {
    if (item.successful || !isTerminal(item.run)) continue
    const reason = failureReason(item.run)
    const entry = failureMap.get(reason) ?? {
      reason,
      runCount: 0,
      usages: [],
    }
    entry.runCount += 1
    entry.usages.push(item.usage)
    failureMap.set(reason, entry)
  }
  const failures = [...failureMap.values()]
    .map((entry) => ({
      reason: entry.reason,
      runCount: entry.runCount,
      usage: sumUsage(entry.usages),
    }))
    .sort((a, b) => b.runCount - a.runCount)

  // models
  const modelMap = new Map<
    string,
    {
      provider: string
      modelId: string
      modelName: string
      runs: EventStats["runs"]
    }
  >()
  for (const item of runRows) {
    const key = `${item.run.provider}::${item.run.modelId}`
    const entry = modelMap.get(key) ?? {
      provider: item.run.provider,
      modelId: item.run.modelId,
      modelName: item.run.modelName,
      runs: [],
    }
    entry.runs.push(item)
    modelMap.set(key, entry)
  }
  const models: EventStats["models"] = [...modelMap.entries()]
    .map(([key, entry]) => {
      const term = entry.runs.filter((r) => isTerminal(r.run))
      const ok = entry.runs.filter((r) => r.successful)
      const usages = entry.runs.map((r) => r.usage)
      const durs = entry.runs.map((r) => r.durationMs)
      return {
        key,
        provider: entry.provider,
        modelId: entry.modelId,
        modelName: entry.modelName,
        runCount: entry.runs.length,
        terminalRunCount: term.length,
        successfulRunCount: ok.length,
        successRate: term.length > 0 ? ok.length / term.length : null,
        averageTokens: average(usages.map((u) => u.totalTokens)),
        averageDurationMs: averageNullable(durs),
        usage: sumUsage(usages),
        cost: costSummary(usages),
        duration: durationSummary(durs),
      }
    })
    .sort((a, b) => b.runCount - a.runCount)

  // trend by createdAt date
  const trendMap = new Map<
    string,
    {
      date: string
      runs: EventStats["runs"]
    }
  >()
  for (const item of runRows) {
    const date = dayKey(item.run.createdAt)
    const entry = trendMap.get(date) ?? { date, runs: [] }
    entry.runs.push(item)
    trendMap.set(date, entry)
  }
  const trend: EventStats["trend"] = [...trendMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      const ok = entry.runs.filter((r) => r.successful)
      const term = entry.runs.filter((r) => isTerminal(r.run))
      const usages = entry.runs.map((r) => r.usage)
      return {
        date: entry.date,
        runCount: entry.runs.length,
        successfulRunCount: ok.length,
        successRate: term.length > 0 ? ok.length / term.length : null,
        totalTokens: usages.reduce((a, u) => a + u.totalTokens, 0),
        knownCost: costSummary(usages).known,
        averageDurationMs: averageNullable(entry.runs.map((r) => r.durationMs)),
      }
    })

  // categories
  const categoryMap = new Map<
    string,
    {
      category: string
      challengeCount: number
      challengeIds: Set<string>
      attempted: Set<string>
      solved: Set<string>
    }
  >()
  for (const row of challengeRows) {
    const category = row.category ?? "uncategorized"
    const entry = categoryMap.get(category) ?? {
      category,
      challengeCount: 0,
      challengeIds: new Set(),
      attempted: new Set(),
      solved: new Set(),
    }
    entry.challengeCount += 1
    entry.challengeIds.add(row.id)
    categoryMap.set(category, entry)
  }
  for (const run of eventRuns) {
    const row = challengeRows.find((c) => c.id === run.challengeId)
    const category = row?.category ?? "uncategorized"
    const entry = categoryMap.get(category)
    if (!entry) continue
    entry.attempted.add(run.challengeId)
    if (isSuccessfulRun(run)) entry.solved.add(run.challengeId)
  }
  const categories: EventStats["categories"] = [...categoryMap.values()]
    .map((entry) => ({
      category: entry.category,
      challengeCount: entry.challengeCount,
      attemptedCount: entry.attempted.size,
      solvedCount: entry.solved.size,
    }))
    .sort((a, b) => b.challengeCount - a.challengeCount)

  const okUsages = runRows.filter((r) => r.successful).map((r) => r.usage)
  const badUsages = runRows
    .filter((r) => isTerminal(r.run) && !r.successful)
    .map((r) => r.usage)
  const outcomes: EventStats["outcomes"] = [
    {
      outcome: "successful",
      runCount: successful.length,
      averageTokens: average(okUsages.map((u) => u.totalTokens)),
      averageDurationMs: averageNullable(
        runRows.filter((r) => r.successful).map((r) => r.durationMs)
      ),
    },
    {
      outcome: "unsuccessful",
      runCount: terminal.length - successful.length,
      averageTokens: average(badUsages.map((u) => u.totalTokens)),
      averageDurationMs: averageNullable(
        runRows
          .filter((r) => isTerminal(r.run) && !r.successful)
          .map((r) => r.durationMs)
      ),
    },
  ]

  const challengeStats: EventStats["challenges"] = challengeRows.map((row) => {
    const items = runRows.filter((r) => r.run.challengeId === row.id)
    const ok = items.filter((r) => r.successful)
    const usages = items.map((r) => r.usage)
    const durs = items.map((r) => r.durationMs)
    return {
      challengeId: row.id,
      challengeName: row.name,
      category: row.category,
      runCount: items.length,
      successfulRunCount: ok.length,
      usage: usages.length ? sumUsage(usages) : emptyUsage(),
      cost: costSummary(usages),
      duration: durationSummary(durs),
    }
  })

  return {
    eventId,
    challengeCount: challengeRows.length,
    attemptedChallengeCount: attemptedChallengeIds.size,
    solvedChallengeCount: solvedChallengeIds.size,
    runCount: eventRuns.length,
    terminalRunCount: terminal.length,
    successfulRunCount: successful.length,
    successRate:
      terminal.length > 0 ? successful.length / terminal.length : null,
    usage,
    cost,
    duration,
    funnel: {
      totalChallenges: challengeRows.length,
      attemptedChallenges: attemptedChallengeIds.size,
      submittedChallenges: submittedChallengeIds.size,
      solvedChallenges: solvedChallengeIds.size,
      totalSubmissions: submissionRows.length,
      acceptedSubmissions: accepted.length,
      rejectedSubmissions: rejected.length,
      submittedRuns: submittedRunIds.size,
      firstAttemptAcceptedRuns,
    },
    failures,
    models,
    trend,
    categories,
    outcomes,
    tools: [],
    challenges: challengeStats,
    runs: runRows,
  }
}
