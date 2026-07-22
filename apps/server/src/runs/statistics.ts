import type { Usage } from "@earendil-works/pi-ai"
import { and, asc, count, eq, sql } from "drizzle-orm"
import type {
  EventCostSummary,
  EventDurationSummary,
  EventStats,
  RunPublic,
  UsageSummary,
} from "../../../shared/api"
import { parseUsage, summarizeUsageRecords, sumUsage } from "../agents/usage"
import type { createDatabase } from "../db"
import {
  agentMessages,
  agentToolCalls,
  agentUsage,
  challenges,
  runAgents,
  runs,
  submissions,
} from "../db/schema"
import { parseModelConfig } from "./config"

type Database = ReturnType<typeof createDatabase>["db"]
type RunStats = EventStats["runs"][number]

export function eventStatistics(
  db: Database,
  eventId: string,
  eventRuns: RunPublic[]
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
  const modelConfigs = new Map(
    db
      .select({ id: runs.id, modelConfig: runs.modelConfig })
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .all()
      .map((row) => [row.id, row.modelConfig])
  )
  const usageRecords = new Map<string, Array<Partial<Usage>>>()
  const addUsage = (runId: string, usage: Partial<Usage>) => {
    const values = usageRecords.get(runId) ?? []
    values.push(usage)
    usageRecords.set(runId, values)
  }

  for (const row of db
    .select({
      runId: runs.id,
      usage: sql<string>`json_extract(${agentMessages.message}, '$.usage')`,
    })
    .from(agentMessages)
    .innerJoin(runAgents, eq(agentMessages.agentId, runAgents.id))
    .innerJoin(runs, eq(runAgents.runId, runs.id))
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .where(
      and(
        eq(challenges.eventId, eventId),
        sql`json_extract(${agentMessages.message}, '$.role') = 'assistant'`
      )
    )
    .all()) {
    addUsage(row.runId, parseUsage(row.usage))
  }
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
  for (const row of db
    .select({ runId: runs.id, usage: agentUsage.usage })
    .from(agentUsage)
    .innerJoin(runAgents, eq(agentUsage.agentId, runAgents.id))
    .innerJoin(runs, eq(runAgents.runId, runs.id))
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .where(eq(challenges.eventId, eventId))
    .all()) {
    addUsage(row.runId, parseUsage(row.usage))
  }

  const runStats = eventRuns.map((run): RunStats => {
    const costKnown =
      parseModelConfig(modelConfigs.get(run.id) ?? "{}").costKnown !== false
    return {
      run,
      usage: summarizeUsageRecords(usageRecords.get(run.id) ?? [], costKnown),
      durationMs: runDuration(run),
      successful: run.hasFlag,
    }
  })
  const runsByChallenge = new Map<string, RunStats[]>()
  for (const item of runStats) {
    const values = runsByChallenge.get(item.run.challengeId) ?? []
    values.push(item)
    runsByChallenge.set(item.run.challengeId, values)
  }

  const challengeStats = challengeRows.map((challenge) => {
    const items = runsByChallenge.get(challenge.id) ?? []
    return {
      challengeId: challenge.id,
      challengeName: challenge.name,
      category: challenge.category,
      runCount: items.length,
      successfulRunCount: items.filter((item) => item.successful).length,
      usage: sumUsage(items.map((item) => item.usage)),
      cost: costSummary(items),
      duration: durationSummary(items),
    }
  })
  const categories = new Map<string, EventStats["categories"][number]>()
  for (const challenge of challengeStats) {
    const category = challenge.category ?? "Uncategorized"
    const value = categories.get(category) ?? {
      category,
      challengeCount: 0,
      attemptedCount: 0,
      solvedCount: 0,
    }
    value.challengeCount += 1
    if (challenge.runCount > 0) value.attemptedCount += 1
    if (challenge.successfulRunCount > 0) value.solvedCount += 1
    categories.set(category, value)
  }
  const terminalRuns = runStats.filter(({ run }) =>
    ["completed", "failed", "stopped"].includes(run.status)
  )
  const successfulRunCount = terminalRuns.filter(
    (item) => item.successful
  ).length

  return {
    eventId,
    challengeCount: challengeStats.length,
    attemptedChallengeCount: challengeStats.filter((item) => item.runCount > 0)
      .length,
    solvedChallengeCount: challengeStats.filter(
      (item) => item.successfulRunCount > 0
    ).length,
    runCount: runStats.length,
    terminalRunCount: terminalRuns.length,
    successfulRunCount,
    successRate:
      terminalRuns.length === 0
        ? null
        : successfulRunCount / terminalRuns.length,
    usage: sumUsage(runStats.map((item) => item.usage)),
    cost: costSummary(runStats),
    duration: durationSummary(terminalRuns),
    funnel: funnelStatistics(challengeStats, submissionRows),
    failures: failureStatistics(terminalRuns),
    models: modelStatistics(runStats, modelConfigs),
    trend: trendStatistics(runStats),
    categories: [...categories.values()].sort(
      (a, b) =>
        b.challengeCount - a.challengeCount ||
        a.category.localeCompare(b.category)
    ),
    outcomes: [
      outcomeSummary(
        "successful",
        terminalRuns.filter((item) => item.successful)
      ),
      outcomeSummary(
        "unsuccessful",
        terminalRuns.filter((item) => !item.successful)
      ),
    ],
    tools: toolStatistics(db, eventId),
    challenges: challengeStats.sort(
      (a, b) => b.usage.totalTokens - a.usage.totalTokens
    ),
    runs: runStats,
  }
}

function funnelStatistics(
  challenges: EventStats["challenges"],
  submissions: Array<{
    runId: string
    challengeId: string
    status: string
    createdAt: string
  }>
): EventStats["funnel"] {
  const accepted = new Set(["accepted", "already_solved"])
  const acceptedChallenges = new Set(
    submissions
      .filter((item) => accepted.has(item.status))
      .map((item) => item.challengeId)
  )
  const firstByRun = new Map<string, string>()
  for (const submission of submissions) {
    if (!firstByRun.has(submission.runId)) {
      firstByRun.set(submission.runId, submission.status)
    }
  }
  return {
    totalChallenges: challenges.length,
    attemptedChallenges: challenges.filter((item) => item.runCount > 0).length,
    submittedChallenges: new Set(submissions.map((item) => item.challengeId))
      .size,
    solvedChallenges: acceptedChallenges.size,
    totalSubmissions: submissions.length,
    acceptedSubmissions: submissions.filter((item) => accepted.has(item.status))
      .length,
    rejectedSubmissions: submissions.filter(
      (item) => item.status === "rejected"
    ).length,
    submittedRuns: firstByRun.size,
    firstAttemptAcceptedRuns: [...firstByRun.values()].filter((status) =>
      accepted.has(status)
    ).length,
  }
}

function failureStatistics(items: RunStats[]): EventStats["failures"] {
  const groups = new Map<string, RunStats[]>()
  for (const item of items) {
    const reason = failureReason(item)
    if (!reason) continue
    const values = groups.get(reason) ?? []
    values.push(item)
    groups.set(reason, values)
  }
  return [...groups.entries()]
    .map(([reason, runs]) => ({
      reason,
      runCount: runs.length,
      usage: sumUsage(runs.map((item) => item.usage)),
    }))
    .sort((a, b) => b.runCount - a.runCount)
}

function failureReason(item: RunStats) {
  if (item.successful) return null
  if (item.run.status === "stopped") return "Stopped"
  if (item.run.status === "completed") return "Completed without flag"
  if (item.run.status !== "failed") return null
  const error = item.run.error?.toLowerCase() ?? ""
  if (/container|workspace|target|environment/.test(error)) {
    return "Environment or target"
  }
  if (/provider|model|assistant|api|rate limit|timeout/.test(error)) {
    return "Provider or model"
  }
  return "Agent or run error"
}

function modelStatistics(
  items: RunStats[],
  modelConfigs: Map<string, string>
): EventStats["models"] {
  const groups = new Map<string, RunStats[]>()
  for (const item of items) {
    const config = parseModelConfig(modelConfigs.get(item.run.id) ?? "{}")
    const key = `${config.provider}/${config.modelId}`
    const values = groups.get(key) ?? []
    values.push(item)
    groups.set(key, values)
  }
  return [...groups.entries()]
    .map(([key, runs]) => {
      const terminal = runs.filter((item) =>
        ["completed", "failed", "stopped"].includes(item.run.status)
      )
      const successful = terminal.filter((item) => item.successful).length
      const durations = terminal.flatMap((item) =>
        item.durationMs === null ? [] : [item.durationMs]
      )
      const first = runs[0].run
      return {
        key,
        provider: first.provider,
        modelId: first.modelId,
        modelName: first.modelName,
        runCount: runs.length,
        terminalRunCount: terminal.length,
        successfulRunCount: successful,
        successRate:
          terminal.length === 0 ? null : successful / terminal.length,
        averageTokens: Math.round(
          runs.reduce((total, item) => total + item.usage.totalTokens, 0) /
            runs.length
        ),
        averageDurationMs:
          durations.length === 0
            ? null
            : Math.round(
                durations.reduce((total, value) => total + value, 0) /
                  durations.length
              ),
        usage: sumUsage(runs.map((item) => item.usage)),
        cost: costSummary(runs),
        duration: durationSummary(terminal),
      }
    })
    .sort((a, b) => b.runCount - a.runCount)
}

function trendStatistics(items: RunStats[]): EventStats["trend"] {
  const groups = new Map<string, RunStats[]>()
  for (const item of items) {
    const date = item.run.createdAt.slice(0, 10)
    const values = groups.get(date) ?? []
    values.push(item)
    groups.set(date, values)
  }
  return [...groups.entries()]
    .map(([date, runs]) => {
      const terminal = runs.filter((item) =>
        ["completed", "failed", "stopped"].includes(item.run.status)
      )
      const successful = terminal.filter((item) => item.successful).length
      const durations = terminal.flatMap((item) =>
        item.durationMs === null ? [] : [item.durationMs]
      )
      return {
        date,
        runCount: runs.length,
        successfulRunCount: successful,
        successRate:
          terminal.length === 0 ? null : successful / terminal.length,
        totalTokens: runs.reduce(
          (total, item) => total + item.usage.totalTokens,
          0
        ),
        knownCost: costSummary(runs).known,
        averageDurationMs:
          durations.length === 0
            ? null
            : Math.round(
                durations.reduce((total, value) => total + value, 0) /
                  durations.length
              ),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

function costSummary(items: Array<{ usage: UsageSummary }>): EventCostSummary {
  return {
    known: items.reduce((total, item) => total + (item.usage.cost ?? 0), 0),
    unknownRunCount: items.filter((item) => item.usage.cost === null).length,
  }
}

function durationSummary(
  items: Array<{ durationMs: number | null }>
): EventDurationSummary {
  const values = items.flatMap((item) =>
    item.durationMs === null ? [] : [item.durationMs]
  )
  return { medianMs: percentile(values, 0.5), p90Ms: percentile(values, 0.9) }
}

function percentile(values: number[], value: number) {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const position = (sorted.length - 1) * value
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const result =
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  return Math.round(result)
}

function runDuration(run: RunPublic) {
  if (
    !run.startedAt ||
    !["completed", "failed", "stopped"].includes(run.status)
  ) {
    return null
  }
  const duration =
    new Date(run.completedAt ?? run.updatedAt).getTime() -
    new Date(run.startedAt).getTime()
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function outcomeSummary(
  outcome: EventStats["outcomes"][number]["outcome"],
  items: RunStats[]
): EventStats["outcomes"][number] {
  const durations = items.flatMap((item) =>
    item.durationMs === null ? [] : [item.durationMs]
  )
  return {
    outcome,
    runCount: items.length,
    averageTokens:
      items.length === 0
        ? 0
        : Math.round(
            items.reduce((total, item) => total + item.usage.totalTokens, 0) /
              items.length
          ),
    averageDurationMs:
      durations.length === 0
        ? null
        : Math.round(
            durations.reduce((total, duration) => total + duration, 0) /
              durations.length
          ),
  }
}

function toolStatistics(db: Database, eventId: string): EventStats["tools"] {
  return db
    .select({
      toolName: agentToolCalls.toolName,
      callCount: count(),
      failedCount: sql<number>`coalesce(sum(case when ${agentToolCalls.succeeded} = 0 then 1 else 0 end), 0)`,
      durationMs: sql<number>`coalesce(sum(${agentToolCalls.durationMs}), 0)`,
      outputBytes: sql<number>`coalesce(sum(${agentToolCalls.outputBytes}), 0)`,
      truncatedCount: sql<number>`coalesce(sum(case when ${agentToolCalls.truncated} = 1 then 1 else 0 end), 0)`,
    })
    .from(agentToolCalls)
    .innerJoin(runAgents, eq(agentToolCalls.agentId, runAgents.id))
    .innerJoin(runs, eq(runAgents.runId, runs.id))
    .innerJoin(challenges, eq(runs.challengeId, challenges.id))
    .where(eq(challenges.eventId, eventId))
    .groupBy(agentToolCalls.toolName)
    .all()
    .map((item) => ({
      toolName: item.toolName,
      callCount: Number(item.callCount),
      failedCount: Number(item.failedCount),
      durationMs: Number(item.durationMs),
      outputBytes: Number(item.outputBytes),
      truncatedCount: Number(item.truncatedCount),
    }))
    .sort((a, b) => b.callCount - a.callCount)
}
