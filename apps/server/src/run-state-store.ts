import { and, eq } from "drizzle-orm"
import type { AgentPublic, RunPublic, UsageSummary } from "../../shared/api"
import type { createDatabase } from "./db"
import { runAgents, runEvents, runs } from "./db/schema"

type Database = ReturnType<typeof createDatabase>["db"]
export type AgentChange = {
  agentId: string
  values: Partial<typeof runAgents.$inferInsert>
}

export function createRunStateStore(options: {
  db: Database
  getRun(runId: string): RunPublic | undefined
  getAgent(agentId: string): typeof runAgents.$inferSelect | undefined
  getPublicAgent(agentId: string): AgentPublic | undefined
  getAgentUsage(agentId: string): UsageSummary
  emitRun(runId: string, run: RunPublic, cursor?: number): void
  emitAgent(
    runId: string,
    agent: AgentPublic,
    usage: UsageSummary,
    cursor?: number
  ): void
}) {
  const { db } = options

  function update(
    runId: string,
    values: Partial<typeof runs.$inferInsert>
  ): RunPublic {
    const updatedAt = new Date().toISOString()
    let cursor: number | undefined
    db.transaction((tx) => {
      tx.update(runs)
        .set({ ...values, updatedAt })
        .where(eq(runs.id, runId))
        .run()
      cursor = tx
        .insert(runEvents)
        .values({ runId, type: "run_updated", createdAt: updatedAt })
        .returning({ id: runEvents.id })
        .get()?.id
    })
    const run = options.getRun(runId)
    if (!run) throw new Error("Run not found")
    options.emitRun(runId, run, cursor)
    return run
  }

  function updateAgent(
    agentId: string,
    values: Partial<typeof runAgents.$inferInsert>
  ): AgentPublic {
    const updatedAt = new Date().toISOString()
    let cursor: number | undefined
    const stored = options.getAgent(agentId)
    if (!stored) throw new Error("Agent not found")
    db.transaction((tx) => {
      tx.update(runAgents)
        .set({ ...values, updatedAt })
        .where(eq(runAgents.id, agentId))
        .run()
      cursor = tx
        .insert(runEvents)
        .values({
          runId: stored.runId,
          type: "agent_updated",
          agentId,
          entityId: agentId,
          createdAt: updatedAt,
        })
        .returning({ id: runEvents.id })
        .get()?.id
    })
    const agent = options.getPublicAgent(agentId)
    if (!agent) throw new Error("Agent not found")
    options.emitAgent(
      agent.runId,
      agent,
      options.getAgentUsage(agent.id),
      cursor
    )
    return agent
  }

  function transition(
    runId: string,
    runValues: Partial<typeof runs.$inferInsert>,
    agentChanges: AgentChange[]
  ) {
    const updatedAt = new Date().toISOString()
    const agentCursors = new Map<string, number>()
    let runCursor: number | undefined
    db.transaction((tx) => {
      for (const change of agentChanges) {
        tx.update(runAgents)
          .set({ ...change.values, updatedAt })
          .where(
            and(eq(runAgents.id, change.agentId), eq(runAgents.runId, runId))
          )
          .run()
        const cursor = tx
          .insert(runEvents)
          .values({
            runId,
            type: "agent_updated",
            agentId: change.agentId,
            entityId: change.agentId,
            createdAt: updatedAt,
          })
          .returning({ id: runEvents.id })
          .get()?.id
        if (cursor !== undefined) agentCursors.set(change.agentId, cursor)
      }
      tx.update(runs)
        .set({ ...runValues, updatedAt })
        .where(eq(runs.id, runId))
        .run()
      runCursor = tx
        .insert(runEvents)
        .values({ runId, type: "run_updated", createdAt: updatedAt })
        .returning({ id: runEvents.id })
        .get()?.id
    })
    for (const change of agentChanges) {
      const agent = options.getPublicAgent(change.agentId)
      if (!agent) continue
      options.emitAgent(
        runId,
        agent,
        options.getAgentUsage(agent.id),
        agentCursors.get(agent.id)
      )
    }
    const run = options.getRun(runId)
    if (!run) throw new Error("Run not found")
    options.emitRun(runId, run, runCursor)
    return run
  }

  return { transition, update, updateAgent }
}
