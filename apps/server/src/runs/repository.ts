import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import type {
  AgentPublic,
  AgentStatus,
  RunPublic,
  RunStatus,
} from "../../../shared"
import type { createDatabase } from "../db"
import {
  challengeRemote,
  challenges,
  events,
  runAgents,
  runEvents,
  runs,
} from "../db/schema"
import {
  type EnvironmentConfig,
  type ModelConfig,
  parseEnvironment,
  parseModelConfig,
} from "./config"
import { RunActionError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]

const publicRunSelection = {
  run: runs,
  challengeName: challenges.name,
  eventId: events.id,
  targetSupported: challengeRemote.targetSupported,
  targetIgnored: challengeRemote.targetIgnored,
  targetAvailable: challengeRemote.available,
}

type PublicRunRow = {
  run: typeof runs.$inferSelect
  challengeName: string
  eventId: string
  targetSupported: boolean | null
  targetIgnored: boolean | null
  targetAvailable: boolean | null
}

export function createRunRepository(db: Database) {
  function getStored(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()
  }

  function getStoredAgent(agentId: string) {
    return db.select().from(runAgents).where(eq(runAgents.id, agentId)).get()
  }

  function getMainAgent(runId: string) {
    return db
      .select()
      .from(runAgents)
      .where(and(eq(runAgents.runId, runId), isNull(runAgents.parentAgentId)))
      .get()
  }

  function listStoredAgents(runId: string) {
    return db
      .select()
      .from(runAgents)
      .where(eq(runAgents.runId, runId))
      .orderBy(runAgents.createdAt, runAgents.id)
      .all()
  }

  function cursor(runId: string) {
    return (
      db
        .select({ value: sql<number>`coalesce(max(${runEvents.id}), 0)` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.value ?? 0
    )
  }

  function runningCount() {
    return (
      db
        .select({ value: count() })
        .from(runAgents)
        .where(inArray(runAgents.status, ["running", "idle"]))
        .get()?.value ?? 0
    )
  }

  function toAgentPublic(agent: typeof runAgents.$inferSelect): AgentPublic {
    return {
      id: agent.id,
      runId: agent.runId,
      parentAgentId: agent.parentAgentId,
      name: agent.name,
      status: agent.status as AgentStatus,
      summary: agent.summary,
      error: agent.error,
      createdAt: agent.createdAt,
      startedAt: agent.startedAt,
      updatedAt: agent.updatedAt,
      completedAt: agent.completedAt,
    }
  }

  function getAgentPublic(agentId: string): AgentPublic | undefined {
    const agent = getStoredAgent(agentId)
    return agent ? toAgentPublic(agent) : undefined
  }

  function publicRun(row: PublicRunRow, includeFlag = false): RunPublic {
    const config = parseModelConfig(row.run.modelConfig)
    const environment = parseEnvironment(row.run.environmentConfig)
    const value: RunPublic = {
      id: row.run.id,
      challengeId: row.run.challengeId,
      challengeName: row.challengeName,
      eventId: row.eventId,
      status: row.run.status as RunStatus,
      provider: config.providerLabel ?? config.provider ?? "",
      modelId: config.modelId ?? "",
      modelName: config.modelLabel ?? config.modelId ?? "",
      thinkingLevel: config.thinkingLevel,
      environment: environment.type,
      targetSupported: Boolean(
        row.targetSupported && row.targetAvailable && !row.targetIgnored
      ),
      createdAt: row.run.createdAt,
      startedAt: row.run.startedAt,
      updatedAt: row.run.updatedAt,
      completedAt: row.run.completedAt,
      error: row.run.error,
      summary: row.run.summary,
      hasFlag: Boolean(row.run.flag),
    }
    if (environment.type === "container") {
      value.image = environment.image
      value.cpus = environment.cpus
      value.memoryMb = environment.memoryMb
      value.pidsLimit = environment.pidsLimit
    }
    if (includeFlag) value.flag = row.run.flag
    return value
  }

  function getPublic(
    runId: string,
    includeFlag = false
  ): RunPublic | undefined {
    const row = db
      .select(publicRunSelection)
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .innerJoin(events, eq(challenges.eventId, events.id))
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(runs.id, runId))
      .get()
    return row ? publicRun(row, includeFlag) : undefined
  }

  function listForEvent(eventId: string): RunPublic[] {
    return db
      .select(publicRunSelection)
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .innerJoin(events, eq(challenges.eventId, events.id))
      .leftJoin(challengeRemote, eq(challenges.id, challengeRemote.challengeId))
      .where(eq(challenges.eventId, eventId))
      .orderBy(desc(runs.createdAt))
      .all()
      .map((row) => publicRun(row))
  }

  function listForChallenge(challengeId: string): RunPublic[] {
    return db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.challengeId, challengeId))
      .orderBy(desc(runs.createdAt))
      .all()
      .map(({ id }) => getPublic(id) as RunPublic)
  }

  function modelConfig(runId: string): ModelConfig | undefined {
    const run = getStored(runId)
    return run ? parseModelConfig(run.modelConfig) : undefined
  }

  function environmentConfig(runId: string): EnvironmentConfig | undefined {
    const run = getStored(runId)
    return run ? parseEnvironment(run.environmentConfig) : undefined
  }

  return {
    getStored,
    getStoredAgent,
    getMainAgent,
    listStoredAgents,
    cursor,
    runningCount,
    toAgentPublic,
    getAgentPublic,
    publicRun,
    getPublic,
    listForEvent,
    listForChallenge,
    modelConfig,
    environmentConfig,
  }
}

export type RunRepository = ReturnType<typeof createRunRepository>

export function requireRun(
  repo: Pick<RunRepository, "getStored">,
  runId: string
) {
  const run = repo.getStored(runId)
  if (!run) throw new RunActionError("not_found", "Run not found")
  return run
}
