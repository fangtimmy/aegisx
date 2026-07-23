import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  sql,
} from "drizzle-orm"
import type { Message, UsageSummary } from "../../../shared"
import { isMessage } from "../../../shared"
import type { createDatabase } from "../db"
import {
  agents,
  agentUsage,
  challengeRemote,
  challenges,
  events,
  messages,
  runs,
} from "../db/schema"
import type { AgentRecord, RunAggregate } from "./types"

type Database = ReturnType<typeof createDatabase>["db"]

function parseMessageRow(row: typeof messages.$inferSelect): Message {
  const body = JSON.parse(row.body) as unknown
  if (!isMessage(body)) {
    throw new Error(`Invalid message body for ${row.id}`)
  }
  // Ensure seq/agentId/id from columns win over body.
  return {
    ...body,
    id: row.id,
    agentId: row.agentId,
    seq: row.seq,
    createdAt: row.createdAt,
    ...(row.clientMessageId && body.role === "user"
      ? { clientMessageId: row.clientMessageId }
      : {}),
  } as Message
}

function toAgentRecord(row: typeof agents.$inferSelect): AgentRecord {
  return {
    id: row.id,
    runId: row.runId,
    parentAgentId: row.parentAgentId,
    name: row.name,
    task: row.task,
    status: row.status as AgentRecord["status"],
    summary: row.summary,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  }
}

export function createRunStore(db: Database) {
  function loadAgents(runId: string): AgentRecord[] {
    return db
      .select()
      .from(agents)
      .where(eq(agents.runId, runId))
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .all()
      .map(toAgentRecord)
  }

  function loadAggregate(runId: string): RunAggregate | null {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) return null
    const agentRows = loadAgents(runId)
    const main = agentRows.find((agent) => agent.parentAgentId === null)
    if (!main) {
      throw new Error(`Run ${runId} has no main agent`)
    }
    return {
      id: run.id,
      challengeId: run.challengeId,
      status: run.status as RunAggregate["status"],
      mainAgentId: main.id,
      modelJson: run.modelJson,
      envJson: run.envJson,
      promptJson: run.promptJson,
      workspacePath: run.workspacePath,
      pendingFinishSummary: run.pendingFinishSummary,
      error: run.error,
      summary: run.summary,
      flag: run.flag,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      agents: agentRows,
    }
  }

  function listRunningRunIds(): string[] {
    return db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "running"))
      .all()
      .map((row) => row.id)
  }

  function globalActiveAgentCount(): number {
    return (
      db
        .select({ value: count() })
        .from(agents)
        .where(inArray(agents.status, ["running", "idle"]))
        .get()?.value ?? 0
    )
  }

  function nextSeq(agentId: string): number {
    const current =
      db
        .select({ value: sql<number>`coalesce(max(${messages.seq}), 0)` })
        .from(messages)
        .where(eq(messages.agentId, agentId))
        .get()?.value ?? 0
    return current + 1
  }

  function findByClientMessageId(
    agentId: string,
    clientMessageId: string
  ): Message | undefined {
    const row = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agentId),
          eq(messages.clientMessageId, clientMessageId)
        )
      )
      .get()
    return row ? parseMessageRow(row) : undefined
  }

  function insertMessage(message: Message): Message {
    const seq = message.seq > 0 ? message.seq : nextSeq(message.agentId)
    const clientMessageId =
      message.role === "user" ? message.clientMessageId : undefined
    const stored: Message = { ...message, seq }
    const body = { ...stored }
    db.insert(messages)
      .values({
        id: stored.id,
        agentId: stored.agentId,
        seq,
        role: stored.role,
        body: JSON.stringify(body),
        clientMessageId: clientMessageId ?? null,
        createdAt: stored.createdAt,
      })
      .run()
    return stored
  }

  function listMessages(
    agentId: string,
    afterSeq = 0,
    limit = 1000
  ): Message[] {
    return db
      .select()
      .from(messages)
      .where(and(eq(messages.agentId, agentId), gt(messages.seq, afterSeq)))
      .orderBy(asc(messages.seq))
      .limit(limit)
      .all()
      .map(parseMessageRow)
  }

  function listRunMessages(
    runId: string,
    afterSeq = 0,
    limit = 5000
  ): Message[] {
    const agentIds = loadAgents(runId).map((agent) => agent.id)
    if (agentIds.length === 0) return []
    // Flat list ordered by createdAt then seq (multi-agent).
    const rows = db
      .select()
      .from(messages)
      .where(inArray(messages.agentId, agentIds))
      .orderBy(asc(messages.createdAt), asc(messages.seq))
      .all()
    const parsed = rows.map(parseMessageRow)
    if (afterSeq <= 0) return parsed.slice(0, limit)
    // afterSeq without agentId is best-effort filter on seq only
    return parsed.filter((message) => message.seq > afterSeq).slice(0, limit)
  }

  /**
   * Persist aggregate snapshot (run row + all agents) in one transaction.
   * Does not write messages (effects handle those).
   */
  function saveAggregate(state: RunAggregate): void {
    db.transaction((tx) => {
      const existing = tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, state.id))
        .get()

      if (!existing) {
        tx.insert(runs)
          .values({
            id: state.id,
            challengeId: state.challengeId,
            status: state.status,
            modelJson: state.modelJson,
            envJson: state.envJson,
            promptJson: state.promptJson,
            workspacePath: state.workspacePath,
            createdAt: state.createdAt,
            startedAt: state.startedAt,
            updatedAt: state.updatedAt,
            completedAt: state.completedAt,
            error: state.error,
            summary: state.summary,
            pendingFinishSummary: state.pendingFinishSummary,
            flag: state.flag,
          })
          .run()
      } else {
        tx.update(runs)
          .set({
            status: state.status,
            modelJson: state.modelJson,
            envJson: state.envJson,
            promptJson: state.promptJson,
            workspacePath: state.workspacePath,
            startedAt: state.startedAt,
            updatedAt: state.updatedAt,
            completedAt: state.completedAt,
            error: state.error,
            summary: state.summary,
            pendingFinishSummary: state.pendingFinishSummary,
            flag: state.flag,
          })
          .where(eq(runs.id, state.id))
          .run()
      }

      for (const agent of state.agents) {
        const row = tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, agent.id))
          .get()
        if (!row) {
          tx.insert(agents)
            .values({
              id: agent.id,
              runId: agent.runId,
              parentAgentId: agent.parentAgentId,
              name: agent.name,
              task: agent.task,
              status: agent.status,
              summary: agent.summary,
              error: agent.error,
              createdAt: agent.createdAt,
              startedAt: agent.startedAt,
              updatedAt: agent.updatedAt,
              completedAt: agent.completedAt,
            })
            .run()
        } else {
          tx.update(agents)
            .set({
              name: agent.name,
              task: agent.task,
              status: agent.status,
              summary: agent.summary,
              error: agent.error,
              startedAt: agent.startedAt,
              updatedAt: agent.updatedAt,
              completedAt: agent.completedAt,
            })
            .where(eq(agents.id, agent.id))
            .run()
        }
      }
    })
  }

  function deleteRun(runId: string): void {
    db.delete(runs).where(eq(runs.id, runId)).run()
  }

  function listRunIdsForEvent(eventId: string): string[] {
    return db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .orderBy(desc(runs.createdAt))
      .all()
      .map((row) => row.id)
  }

  function listRunIdsForChallenge(challengeId: string): string[] {
    return db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.challengeId, challengeId))
      .orderBy(desc(runs.createdAt))
      .all()
      .map((row) => row.id)
  }

  function challengeMeta(challengeId: string) {
    const row = db
      .select({
        name: challenges.name,
        eventId: events.id,
        targetSupported: challengeRemote.targetSupported,
        targetIgnored: challengeRemote.targetIgnored,
        targetAvailable: challengeRemote.available,
      })
      .from(challenges)
      .innerJoin(events, eq(challenges.eventId, events.id))
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(challenges.id, challengeId))
      .get()
    if (!row) return undefined
    return {
      name: row.name,
      eventId: row.eventId,
      targetSupported: Boolean(
        row.targetSupported &&
          !row.targetIgnored &&
          (row.targetAvailable ?? true)
      ),
    }
  }

  /**
   * Large TEXT columns can return null via drizzle select in some bun/sqlite
   * paths; prefer the underlying bun:sqlite client when available.
   */
  function rawTextColumn(
    table: string,
    column: string,
    id: string
  ): string | null {
    const client = (
      db as unknown as {
        $client?: {
          query: (sql: string) => {
            get: (id: string) => Record<string, string | null> | null
          }
        }
      }
    ).$client
    if (!client) return null
    const row = client
      .query(`select ${column} as value from ${table} where id = ?`)
      .get(id)
    const value = row?.value
    return typeof value === "string" ? value : null
  }

  function getRuntimeSnapshot(agentId: string): string | null {
    const viaRaw = rawTextColumn("agents", "runtime_snapshot", agentId)
    if (viaRaw !== null) return viaRaw
    return (
      db
        .select({ runtimeSnapshot: agents.runtimeSnapshot })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get()?.runtimeSnapshot ?? null
    )
  }

  function usageForAgent(agentId: string): UsageSummary {
    const rows = db
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.agentId, agentId))
      .all()
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let totalTokens = 0
    let cost = 0
    let unknownCost = false
    for (const row of rows) {
      try {
        const usage = JSON.parse(row.usage) as Record<string, unknown>
        input += Number(usage.input ?? 0) || 0
        output += Number(usage.output ?? 0) || 0
        cacheRead += Number(usage.cacheRead ?? 0) || 0
        cacheWrite += Number(usage.cacheWrite ?? 0) || 0
        totalTokens += Number(usage.totalTokens ?? 0) || 0
        const c = usage.cost
        if (c === null) unknownCost = true
        else if (typeof c === "number") cost += c
        else if (c && typeof c === "object" && "total" in c) {
          cost += Number((c as { total: unknown }).total ?? 0) || 0
        }
      } catch {
        // skip bad rows
      }
    }
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: unknownCost ? null : cost,
    }
  }

  return {
    loadAggregate,
    listRunningRunIds,
    listRunIdsForEvent,
    listRunIdsForChallenge,
    challengeMeta,
    globalActiveAgentCount,
    nextSeq,
    findByClientMessageId,
    insertMessage,
    listMessages,
    listRunMessages,
    saveAggregate,
    deleteRun,
    getRuntimeSnapshot,
    usageForAgent,
    getMainAgentId(runId: string): string | undefined {
      return db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.runId, runId), isNull(agents.parentAgentId)))
        .get()?.id
    },
  }
}

export type RunStore = ReturnType<typeof createRunStore>
