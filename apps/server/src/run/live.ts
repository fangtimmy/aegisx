import type { LiveEvent } from "../../../shared"
import type { createDatabase } from "../db"
import type { SettingsPublic } from "../infrastructure/config-store"
import type { TargetState } from "../platforms/core"
import type { ModelService } from "../providers/models"
import { createContainerPool } from "./container-pool"
import {
  createRunService,
  type RunService,
  type RunServiceOptions,
} from "./service"
import {
  createSessionRegistry,
  createSessionRuntime,
  type SessionHost,
} from "./session"
import type { RunStore } from "./store"

type Database = ReturnType<typeof createDatabase>["db"]

/**
 * Wire RunService to real session/runtime/container stack.
 * Call recoverOnBoot() after create.
 */
export function createLiveRunService(options: {
  db: Database
  dataDir: string
  maxConcurrency: number
  modelService: ModelService
  getSettings(): SettingsPublic
  getApiKeys?: (provider: string) => Iterable<string>
  onLiveEvent?: (runId: string, event: LiveEvent) => void
  resolveChallenge?: RunServiceOptions["resolveChallenge"]
  canFinishRun?(runId: string, challengeId: string): boolean
  submitFlag?(
    runId: string,
    challengeId: string,
    flag?: string,
    signal?: AbortSignal
  ): Promise<unknown>
  targetAction?(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop",
    signal?: AbortSignal
  ): Promise<TargetState>
}) {
  const sessions = createSessionRegistry()
  let serviceRef: RunService | undefined

  const containers = createContainerPool({
    dataDir: options.dataDir,
    onFailure: (runId) => {
      void sessions.abortRun(runId)
      void serviceRef?.containerFailed(
        runId,
        "Container execution became unavailable"
      )
    },
  })

  const storeRef: { current: RunStore | null } = { current: null }

  const host: SessionHost = {
    db: options.db,
    dataDir: options.dataDir,
    get store() {
      if (!storeRef.current) throw new Error("store not ready")
      return storeRef.current
    },
    sessions,
    containers,
    modelService: options.modelService,
    getSettings: options.getSettings,
    getApiKeys: options.getApiKeys,
    onLiveEvent: (runId, event) => options.onLiveEvent?.(runId, event),
    onSettled: (runId, agentId, outcome) => {
      if (!serviceRef) return
      return serviceRef.onSettled(runId, agentId, outcome)
    },
    requestFinish: (runId, summary) => {
      if (!serviceRef) return
      return serviceRef.requestFinish(runId, summary)
    },
    spawnChild: async (runId, parentId, name, task) => {
      if (!serviceRef) throw new Error("service not ready")
      const child = await serviceRef.spawn(runId, parentId, name, task)
      return {
        id: child.id,
        runId: child.runId,
        parentAgentId: child.parentAgentId,
        name: child.name,
        status: child.status,
        summary: child.summary,
        error: child.error,
        createdAt: child.createdAt,
        startedAt: child.startedAt,
        updatedAt: child.updatedAt,
        completedAt: child.completedAt,
      }
    },
    canFinishRun: options.canFinishRun,
    submitFlag: options.submitFlag,
    targetAction: options.targetAction,
  }

  const runtime = createSessionRuntime(host)

  const service = createRunService({
    db: options.db,
    dataDir: options.dataDir,
    maxConcurrency: options.maxConcurrency,
    runtime,
    onLiveEvent: options.onLiveEvent,
    resolveChallenge: options.resolveChallenge,
    activeSessionCount: () => sessions.size,
  })
  serviceRef = service
  storeRef.current = service.store

  const baseClose = service.close.bind(service)
  return {
    ...service,
    sessions,
    containers,
    close: async () => {
      await baseClose()
      sessions.disposeAll()
      await containers.releaseAll()
    },
  }
}
