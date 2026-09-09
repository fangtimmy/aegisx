import type {
  EventAgentEfficiency,
  EventCategoryStats,
  EventChallengeEfficiency,
  EventConcurrencyPoint,
  EventMessageBucket,
  EventModelBillingItem,
  EventScorePoint,
  EventStats,
  EventStatsAgentSpan,
  EventToolUsageItem,
} from "@aegisx/shared"
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm"

import { roleField, usageField } from "../agents/session-queries"
import type { Database } from "../db"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
  channelMessages,
  sessionEntries,
  spawnQueue,
} from "../db/schema"
import {
  isPlatformIntegrated,
  type ChallengeRemote,
} from "../platforms/challenge-state"

/** Sum of one guarded usage field over entries joined to the event's agents,
 * grouped by a column of `agents`. Shares the JSON1 extractors with
 * sumUsageTotals (agents/session-queries). */
const sumUsageField = (msgPath: string, entryPath: string) => sql<number>`
    SUM(
      CASE
        WHEN ${sessionEntries.type} IN ('compaction', 'branch_summary')
          THEN ${usageField(entryPath)}
        WHEN ${sessionEntries.type} = 'message'
          AND ${roleField} IN ('assistant', 'toolResult')
          THEN ${usageField(msgPath)}
        ELSE 0
      END
    )
  `

function usageByAgentGroup(
  db: Database,
  eventId: string,
  group: typeof agents.model | typeof agents.challengeId | typeof agents.id
) {
  return db
    .select({
      key: group,
      input: sumUsageField("$.message.usage.input", "$.usage.input"),
      output: sumUsageField("$.message.usage.output", "$.usage.output"),
      cacheRead: sumUsageField(
        "$.message.usage.cacheRead",
        "$.usage.cacheRead"
      ),
      cacheWrite: sumUsageField(
        "$.message.usage.cacheWrite",
        "$.usage.cacheWrite"
      ),
      cost: sumUsageField("$.message.usage.cost.total", "$.usage.cost.total"),
      turns: sql<number>`SUM(CASE WHEN ${sessionEntries.type} = 'message' AND ${roleField} = 'assistant' THEN 1 ELSE 0 END)`,
      toolCalls: sql<number>`SUM(CASE WHEN ${sessionEntries.type} = 'message' AND ${roleField} = 'toolResult' THEN 1 ELSE 0 END)`,
    })
    .from(sessionEntries)
    .innerJoin(agents, eq(sessionEntries.agentId, agents.id))
    .where(eq(agents.eventId, eventId))
    .groupBy(group)
    .all()
}

/** Agent wall interval end: completedAt for terminal agents, `now` only for
 * actively-running ones (they are producing output right now). idle agents
 * end at their last activity — an idle wait can span hours and would
 * otherwise stretch the timeline far past the real work. */
function agentSpanEnd(
  row: typeof agents.$inferSelect,
  now: string
): string | null {
  if (row.completedAt) return row.completedAt
  return row.status === "running" ? now : row.updatedAt
}

export function buildEventStats(db: Database, eventId: string): EventStats {
  const now = new Date().toISOString()

  const challengeRows = db
    .select({ challenge: challenges, remote: challengeRemote })
    .from(challenges)
    .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
    .where(eq(challenges.eventId, eventId))
    .all()
  const agentRows = db
    .select()
    .from(agents)
    .where(eq(agents.eventId, eventId))
    .all()
  const solverRows = agentRows.filter((row) => row.role === "solver")
  const challengeIds = challengeRows.map(({ challenge }) => challenge.id)
  const flagRows =
    challengeIds.length === 0
      ? []
      : db
          .select({
            challengeId: challengeFlags.challengeId,
            status: challengeFlags.status,
            source: challengeFlags.source,
            agentId: challengeFlags.agentId,
            createdAt: challengeFlags.createdAt,
            updatedAt: challengeFlags.updatedAt,
          })
          .from(challengeFlags)
          .where(inArray(challengeFlags.challengeId, challengeIds))
          .all()
  const queueRows = db
    .select({
      agentId: spawnQueue.agentId,
      status: spawnQueue.status,
      createdAt: spawnQueue.createdAt,
    })
    .from(spawnQueue)
    .where(eq(spawnQueue.eventId, eventId))
    .all()

  // --- Overview ---------------------------------------------------------
  const flagsByChallenge = new Map<string, typeof flagRows>()
  for (const flag of flagRows) {
    const values = flagsByChallenge.get(flag.challengeId) ?? []
    values.push(flag)
    flagsByChallenge.set(flag.challengeId, values)
  }
  // The fully-solved rule (see challenge-state): an accepted local flag only
  // counts where no platform verdict exists — integrated accepted rows can
  // be multi-flag partials.
  const solvedOf = (
    challengeId: string,
    manual: string,
    remote: ChallengeRemote | null
  ) =>
    remote?.solved === true ||
    manual !== "unsolved" ||
    (!isPlatformIntegrated(remote) &&
      (flagsByChallenge.get(challengeId) ?? []).some(
        (f) => f.status === "accepted"
      ))
  let challengesSolved = 0
  let pointsEarned = 0
  let pointsAvailable = 0
  const solvedByChallenge = new Map<string, boolean>()
  for (const { challenge, remote } of challengeRows) {
    if (challenge.points !== null) pointsAvailable += challenge.points
    const solved = solvedOf(challenge.id, challenge.manualSolveState, remote)
    solvedByChallenge.set(challenge.id, solved)
    if (solved) {
      challengesSolved += 1
      pointsEarned += challenge.points ?? 0
    }
  }

  // Usage: total + per-model + per-challenge + per-agent (aggregate passes).
  let total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  }
  const usageByAgent = new Map<
    string,
    {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      cost: number
      turns: number
      toolCalls: number
    }
  >()
  for (const row of usageByAgentGroup(db, eventId, agents.id)) {
    if (row.key === null) continue
    usageByAgent.set(row.key, row)
  }
  const solverAgentsByModel = new Map<string, number>()
  for (const row of solverRows) {
    solverAgentsByModel.set(
      row.model,
      (solverAgentsByModel.get(row.model) ?? 0) + 1
    )
  }
  const modelOfAgent = new Map(agentRows.map((row) => [row.id, row.model]))
  const solvesByModel = new Map<string, number>()
  for (const flag of flagRows) {
    if (flag.status !== "accepted" || flag.agentId === null) continue
    const model = modelOfAgent.get(flag.agentId)
    if (model === undefined) continue
    solvesByModel.set(model, (solvesByModel.get(model) ?? 0) + 1)
  }
  const modelBilling: EventModelBillingItem[] = []
  for (const row of usageByAgentGroup(db, eventId, agents.model)) {
    if (row.key === null) continue
    total.input += row.input
    total.output += row.output
    total.cacheRead += row.cacheRead
    total.cacheWrite += row.cacheWrite
    total.cost += row.cost
    total.turns += row.turns
    modelBilling.push({
      model: row.key,
      requests: row.turns,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      cost: row.cost,
      solverAgents: solverAgentsByModel.get(row.key) ?? 0,
      solves: solvesByModel.get(row.key) ?? 0,
    })
  }
  modelBilling.sort((a, b) => b.cost - a.cost || b.requests - a.requests)

  const usageByChallenge = new Map<string, { tokens: number; cost: number }>()
  for (const row of usageByAgentGroup(db, eventId, agents.challengeId)) {
    if (row.key === null) continue
    usageByChallenge.set(row.key, {
      tokens: row.input + row.output + row.cacheRead + row.cacheWrite,
      cost: row.cost,
    })
  }

  // --- Score timeline ---------------------------------------------------
  const scoreTimeline: EventScorePoint[] = []
  for (const flag of flagRows) {
    if (flag.status !== "accepted") continue
    const entry = challengeRows.find(
      ({ challenge }) => challenge.id === flag.challengeId
    )
    if (!entry) continue
    scoreTimeline.push({
      time: flag.updatedAt,
      challengeId: entry.challenge.id,
      challengeName: entry.challenge.name,
      points: entry.challenge.points ?? 0,
      cumulative: 0,
      source: flag.source,
    })
  }
  for (const { challenge, remote } of challengeRows) {
    const hasAccepted = (flagsByChallenge.get(challenge.id) ?? []).some(
      (f) => f.status === "accepted"
    )
    if (hasAccepted) continue
    const manualSolved = challenge.manualSolveState !== "unsolved"
    const remoteSolved = remote?.solved ?? false
    if (!manualSolved && !remoteSolved) continue
    scoreTimeline.push({
      time: challenge.updatedAt,
      challengeId: challenge.id,
      challengeName: challenge.name,
      points: challenge.points ?? 0,
      cumulative: 0,
      source: manualSolved ? "manual" : "remote",
    })
  }
  scoreTimeline.sort((a, b) => a.time.localeCompare(b.time))
  let cumulative = 0
  for (const point of scoreTimeline) {
    cumulative += point.points
    point.cumulative = cumulative
  }

  // --- Per-challenge efficiency ----------------------------------------
  const challengeEfficiency: EventChallengeEfficiency[] = challengeRows.map(
    ({ challenge }) => {
      const rows = solverRows.filter((row) => row.challengeId === challenge.id)
      const usage = usageByChallenge.get(challenge.id)
      const flags = flagsByChallenge.get(challenge.id) ?? []
      return {
        challengeId: challenge.id,
        name: challenge.name,
        category: challenge.category,
        points: challenge.points,
        solved: solvedByChallenge.get(challenge.id) ?? false,
        attempts: rows.length,
        tokens: usage?.tokens ?? 0,
        cost: usage?.cost ?? 0,
        durationMs: rows.reduce((sum, row) => {
          const end = agentSpanEnd(row, now)
          return row.startedAt && end
            ? sum + Math.max(0, Date.parse(end) - Date.parse(row.startedAt))
            : sum
        }, 0),
        submissions: flags.length,
        rejectedSubmissions: flags.filter((f) => f.status === "rejected")
          .length,
        messages: 0,
      }
    }
  )

  // --- Per-agent efficiency --------------------------------------------
  const challengeNameOf = new Map(
    challengeRows.map(({ challenge }) => [challenge.id, challenge.name])
  )
  const agentEfficiency: EventAgentEfficiency[] = agentRows.map((row) => {
    const usage = usageByAgent.get(row.id)
    const end = agentSpanEnd(row, now)
    const durationMs =
      row.startedAt && end
        ? Math.max(0, Date.parse(end) - Date.parse(row.startedAt))
        : 0
    const idleMs =
      row.status === "idle" && !row.completedAt
        ? Math.max(0, Date.parse(now) - Date.parse(row.updatedAt))
        : 0
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      challengeId: row.challengeId,
      challengeName:
        row.challengeId !== null
          ? (challengeNameOf.get(row.challengeId) ?? null)
          : null,
      model: row.model,
      source: row.source,
      status: row.status,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      cost: usage?.cost ?? 0,
      turns: usage?.turns ?? 0,
      toolCalls: usage?.toolCalls ?? 0,
      durationMs,
      idleMs,
      error: row.error,
      summary: row.summary,
    }
  })
  agentEfficiency.sort((a, b) => b.cost - a.cost || b.durationMs - a.durationMs)

  // --- Per-category stats -----------------------------------------------
  const categoryRows = new Map<
    string | null,
    {
      challenges: number
      solved: number
      points: number
      pointsAvailable: number
    }
  >()
  for (const { challenge } of challengeRows) {
    const bucket = categoryRows.get(challenge.category) ?? {
      challenges: 0,
      solved: 0,
      points: 0,
      pointsAvailable: 0,
    }
    bucket.challenges += 1
    if (solvedByChallenge.get(challenge.id)) {
      bucket.solved += 1
      bucket.points += challenge.points ?? 0
    }
    bucket.pointsAvailable += challenge.points ?? 0
    categoryRows.set(challenge.category, bucket)
  }
  const categoryOfChallenge = new Map(
    challengeRows.map(({ challenge }) => [challenge.id, challenge.category])
  )
  const attemptsByCategory = new Map<string | null, number>()
  for (const row of solverRows) {
    const category =
      row.challengeId !== null
        ? (categoryOfChallenge.get(row.challengeId) ?? null)
        : null
    attemptsByCategory.set(
      category,
      (attemptsByCategory.get(category) ?? 0) + 1
    )
  }
  const usageByCategory = new Map<
    string | null,
    { tokens: number; cost: number }
  >()
  for (const [challengeId, usage] of usageByChallenge) {
    const category = categoryOfChallenge.get(challengeId) ?? null
    const prev = usageByCategory.get(category)
    usageByCategory.set(category, {
      tokens: (prev?.tokens ?? 0) + usage.tokens,
      cost: (prev?.cost ?? 0) + usage.cost,
    })
  }
  const categoryStats: EventCategoryStats[] = [...categoryRows].map(
    ([category, bucket]) => ({
      category,
      ...bucket,
      attempts: attemptsByCategory.get(category) ?? 0,
      tokens: usageByCategory.get(category)?.tokens ?? 0,
      cost: usageByCategory.get(category)?.cost ?? 0,
    })
  )
  categoryStats.sort(
    (a, b) => b.points - a.points || b.challenges - a.challenges
  )

  // --- Concurrency + agent timeline + failures --------------------------
  const deltas: Array<{ time: string; delta: number }> = []
  const agentTimeline: EventStatsAgentSpan[] = []
  for (const row of solverRows) {
    if (!row.startedAt) continue
    const end = agentSpanEnd(row, now)
    if (!end) continue
    deltas.push({ time: row.startedAt, delta: 1 })
    // Only actively-running agents stay open (no closing delta) — their slot
    // holds through the right edge. idle closes at its last activity.
    const live = !row.completedAt && row.status === "running"
    if (!live) deltas.push({ time: end, delta: -1 })
    agentTimeline.push({
      id: row.id,
      name: row.name ?? row.id,
      challengeId: row.challengeId,
      challengeName:
        challengeRows.find(({ challenge }) => challenge.id === row.challengeId)
          ?.challenge.name ?? null,
      model: row.model,
      source: row.source,
      status: row.status,
      start: row.startedAt,
      end,
    })
  }
  const schedulerRow = agentRows.find((row) => row.role === "orchestrator")
  if (schedulerRow?.startedAt) {
    const end = agentSpanEnd(schedulerRow, now)
    if (end) {
      agentTimeline.push({
        id: schedulerRow.id,
        name: schedulerRow.name ?? "Scheduler",
        challengeId: null,
        challengeName: null,
        model: schedulerRow.model,
        source: schedulerRow.source,
        status: schedulerRow.status,
        start: schedulerRow.startedAt,
        end,
      })
    }
  }
  deltas.sort((a, b) => a.time.localeCompare(b.time) || a.delta - b.delta)
  const concurrency: EventConcurrencyPoint[] = []
  let running = 0
  for (const { time, delta } of deltas) {
    running += delta
    concurrency.push({ time, running })
  }
  agentTimeline.sort((a, b) => a.start.localeCompare(b.start))

  // --- Queue + spawn source --------------------------------------------
  const startedAtByAgent = new Map(
    agentRows.map((row) => [row.id, row.startedAt])
  )
  const queueWaits: number[] = []
  let queueDone = 0
  let queueFailed = 0
  let queueCancelled = 0
  for (const row of queueRows) {
    if (row.status === "done") queueDone += 1
    else if (row.status === "failed") queueFailed += 1
    else if (row.status === "cancelled") queueCancelled += 1
    const startedAt = row.agentId
      ? startedAtByAgent.get(row.agentId)
      : undefined
    if (row.agentId && startedAt) {
      queueWaits.push(
        Math.max(0, Date.parse(startedAt) - Date.parse(row.createdAt))
      )
    }
  }

  // --- Team-channel message activity (per hour + per challenge) ---------
  const messageBuckets: EventMessageBucket[] = []
  const messagesByChallenge = new Map<string, number>()
  if (challengeIds.length > 0) {
    const teamKeys = challengeIds.map((id) => `team:${id}`)
    const bucketExpr = sql<string>`substr(${channelMessages.createdAt}, 1, 13)`
    const bucketRows = db
      .select({ bucket: bucketExpr, count: count() })
      .from(channelMessages)
      .where(inArray(channelMessages.channelKey, teamKeys))
      .groupBy(bucketExpr)
      .orderBy(asc(bucketExpr))
      .all()
    for (const row of bucketRows) {
      messageBuckets.push({ bucket: `${row.bucket}:00`, count: row.count })
    }
    const perChannel = db
      .select({ key: channelMessages.channelKey, count: count() })
      .from(channelMessages)
      .where(inArray(channelMessages.channelKey, teamKeys))
      .groupBy(channelMessages.channelKey)
      .all()
    for (const row of perChannel) {
      messagesByChallenge.set(row.key.slice("team:".length), row.count)
    }
  }
  for (const entry of challengeEfficiency) {
    entry.messages = messagesByChallenge.get(entry.challengeId) ?? 0
  }

  // --- Message volume by channel kind -----------------------------------
  const eventChannelKeys = [
    ...challengeIds.map((id) => `team:${id}`),
    ...agentRows.map((row) => `dm:${row.id}`),
    `orch:${eventId}`,
  ]
  const messageKinds = { team: 0, dm: 0, orch: 0 }
  if (eventChannelKeys.length > 0) {
    const kindRows = db
      .select({ key: channelMessages.channelKey, count: count() })
      .from(channelMessages)
      .where(inArray(channelMessages.channelKey, eventChannelKeys))
      .groupBy(channelMessages.channelKey)
      .all()
    for (const row of kindRows) {
      const kind = row.key.slice(0, row.key.indexOf(":"))
      if (kind === "team" || kind === "dm" || kind === "orch") {
        messageKinds[kind] += row.count
      }
    }
  }

  // --- Tool usage -------------------------------------------------------
  const toolExpr = sql<string>`json_extract(CASE WHEN json_valid(${sessionEntries.data}) THEN ${sessionEntries.data} END, ${"$.message.toolName"})`
  const toolRows = db
    .select({ tool: toolExpr, calls: count() })
    .from(sessionEntries)
    .innerJoin(agents, eq(sessionEntries.agentId, agents.id))
    .where(
      and(
        eq(agents.eventId, eventId),
        eq(sessionEntries.type, "message"),
        sql`${roleField} = 'toolResult'`
      )
    )
    .groupBy(toolExpr)
    .orderBy(desc(count()))
    .limit(10)
    .all()
  const toolUsage: EventToolUsageItem[] = toolRows.flatMap((row) =>
    row.tool === null ? [] : [{ tool: row.tool, calls: row.calls }]
  )

  // --- Window -----------------------------------------------------------
  const times = [
    ...agentRows.flatMap((row) => [
      row.startedAt,
      row.updatedAt,
      row.completedAt,
    ]),
    ...flagRows.map((flag) => flag.updatedAt),
    ...challengeRows.map(({ challenge }) => challenge.updatedAt),
  ].filter((value): value is string => value !== null)
  const startedList = agentRows
    .map((row) => row.startedAt)
    .filter((value): value is string => value !== null)
    .toSorted()
  const start =
    startedList[0] ??
    challengeRows.map(({ challenge }) => challenge.createdAt).toSorted()[0] ??
    null
  const end = times.toSorted().at(-1) ?? null

  return {
    window: { start, end },
    overview: {
      challengesTotal: challengeRows.length,
      challengesSolved,
      pointsEarned,
      pointsAvailable,
      attempts: solverRows.length,
      attemptsActive: solverRows.filter(
        (row) => row.status === "running" || row.status === "idle"
      ).length,
      inputTokens: total.input,
      outputTokens: total.output,
      cacheReadTokens: total.cacheRead,
      cacheWriteTokens: total.cacheWrite,
      turns: total.turns,
      cost: total.cost,
    },
    scoreTimeline,
    modelBilling,
    challengeEfficiency,
    concurrency,
    spawnSource: {
      scheduler: solverRows.filter((row) => row.source === "scheduler").length,
      manual: solverRows.filter((row) => row.source === "manual").length,
    },
    queue: {
      done: queueDone,
      failed: queueFailed,
      cancelled: queueCancelled,
      avgWaitMs:
        queueWaits.length > 0
          ? queueWaits.reduce((sum, value) => sum + value, 0) /
            queueWaits.length
          : null,
    },
    messageActivity: messageBuckets,
    messageKinds,
    toolUsage,
    failures: {
      timeouts: solverRows.filter((row) => row.lastTimeoutAt !== null).length,
      aborted: solverRows.filter((row) => row.status === "aborted").length,
      failed: solverRows.filter((row) => row.status === "failed").length,
    },
    agentTimeline,
    agentEfficiency,
    categoryStats,
  }
}
