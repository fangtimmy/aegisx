import { join } from "node:path"
import type { AgentSummary, RunPublic, UsageSummary } from "../../../shared"
import type { ChallengeMeta } from "./public"
import { toRunPublic } from "./public"
import type { RunStore } from "./store"
import type { RunAggregate } from "./types"

export type RunQueries = ReturnType<typeof createRunQueries>

export function createRunQueries(options: {
  store: RunStore
  dataDir?: string
  resolveChallenge?: (challengeId: string) => ChallengeMeta | undefined
}) {
  const { store } = options

  function resolveChallenge(challengeId: string) {
    return (
      options.resolveChallenge?.(challengeId) ??
      store.challengeMeta(challengeId)
    )
  }

  function mapPublic(state: RunAggregate): RunPublic {
    return toRunPublic(state, resolveChallenge(state.challengeId))
  }

  function get(runId: string): RunPublic | undefined {
    const state = store.loadAggregate(runId)
    return state ? mapPublic(state) : undefined
  }

  function getAggregate(runId: string) {
    return store.loadAggregate(runId)
  }

  function agents(runId: string): AgentSummary[] {
    const state = store.loadAggregate(runId)
    if (!state) return []
    return state.agents.map((agent) => ({
      ...agent,
      usage: store.usageForAgent(agent.id),
    }))
  }

  function getAgent(runId: string, agentId: string): AgentSummary | undefined {
    const state = store.loadAggregate(runId)
    const row = state?.agents.find((a) => a.id === agentId)
    if (!row) return undefined
    return { ...row, usage: store.usageForAgent(agentId) }
  }

  function agentUsage(agentId: string): UsageSummary {
    return store.usageForAgent(agentId)
  }

  function usage(runId: string): UsageSummary {
    const state = store.loadAggregate(runId)
    if (!state) {
      return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: null,
      }
    }
    return state.agents
      .map((a) => store.usageForAgent(a.id))
      .reduce(
        (acc, item) => ({
          input: acc.input + item.input,
          output: acc.output + item.output,
          cacheRead: acc.cacheRead + item.cacheRead,
          cacheWrite: acc.cacheWrite + item.cacheWrite,
          totalTokens: acc.totalTokens + item.totalTokens,
          cost:
            acc.cost === null || item.cost === null
              ? null
              : (acc.cost ?? 0) + item.cost,
        }),
        {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0 as number | null,
        }
      )
  }

  function listForEvent(eventId: string): RunPublic[] {
    return store
      .listRunIdsForEvent(eventId)
      .map((id) => get(id))
      .filter((run): run is RunPublic => Boolean(run))
  }

  function listForChallenge(challengeId: string): RunPublic[] {
    return store
      .listRunIdsForChallenge(challengeId)
      .map((id) => get(id))
      .filter((run): run is RunPublic => Boolean(run))
  }

  function workspacePath(runId: string): string | undefined {
    const state = store.loadAggregate(runId)
    if (!state?.workspacePath || !options.dataDir) return undefined
    return join(options.dataDir, state.workspacePath)
  }

  function inspector(runId: string, agentId: string) {
    const state = store.loadAggregate(runId)
    const row = state?.agents.find((a) => a.id === agentId)
    if (!state || !row) return undefined
    let runtime: {
      capturedAt?: string
      systemPrompt?: string
      cwd?: string
      model?: unknown
      tools: Array<{ name: string; description?: string; parameters?: unknown }>
    } = { tools: [] }
    try {
      const snapshotText = store.getRuntimeSnapshot(agentId)
      if (snapshotText) {
        const parsed = JSON.parse(snapshotText) as {
          capturedAt?: string
          systemPrompt?: string
          cwd?: string
          model?: unknown
          tools?: Array<{
            name: string
            description?: string
            parameters?: unknown
          }>
        }
        runtime = {
          capturedAt: parsed.capturedAt,
          systemPrompt: parsed.systemPrompt ?? "",
          cwd: parsed.cwd ?? "",
          model: parsed.model,
          tools: Array.isArray(parsed.tools)
            ? parsed.tools.map((tool) => ({
                name: String(tool?.name ?? "unknown"),
                description: tool?.description,
                parameters: tool?.parameters ?? {},
              }))
            : [],
        }
      }
    } catch {
      runtime = { tools: [], systemPrompt: "" }
    }
    return {
      agent: {
        id: row.id,
        runId: row.runId,
        parentAgentId: row.parentAgentId,
        name: row.name,
        status: row.status,
        summary: row.summary,
        error: row.error,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
      },
      task: row.task,
      runtime,
      usage: store.usageForAgent(agentId),
      toolStats: [],
    }
  }

  return {
    mapPublic,
    get,
    getAggregate,
    agents,
    getAgent,
    agentUsage,
    usage,
    listForEvent,
    listForChallenge,
    workspacePath,
    inspector,
  }
}
