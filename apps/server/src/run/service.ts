import { mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { eq } from "drizzle-orm"
import type {
  EnvironmentConfig,
  FlatSettings,
  ModelConfig,
  RunPublic,
} from "../../../shared"
import type { ProviderConnection } from "../../../shared/provider"
import type { ThinkingLevel } from "../../../shared/thinking"
import type { createDatabase } from "../db"
import { challenges, runs } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { getChallengeRemote } from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import {
  renderInitialPrompt,
  renderSystemPrompt,
  resolvePromptTemplates,
} from "../settings/prompt-templates"
import type { ContainerManager } from "./container-manager"
import { discoverPiSessionId } from "./container-manager"
import { RunActionError } from "./errors"
import {
  buildContainerEnv,
  buildPiCmd,
  generatePiAgentVolume,
  piModelRefFor,
} from "./pi-launch"
import { buildPromptContext, copyAttachments } from "./prompt"
import { createPtyBridge, type PtyBridge } from "./pty-bridge"
import { createRunQueries } from "./queries"

type Database = ReturnType<typeof createDatabase>["db"]
type PlatformService = ReturnType<typeof createPlatformService>

const RUNS_SUBDIR = "runs"

export type RunServiceOptions = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  configStore: ConfigStore
  getSettings(): FlatSettings
}

type PendingOutcome = { mode: "finish"; summary: string } | { mode: "stop" }

export type CreateRunInput = {
  challengeId: string
  provider: ProviderConnection
  /** ProviderModel.id */
  modelId: string
  thinkingLevel: ThinkingLevel
  container: {
    image: string
    cpus: number
    memoryMb: number
    pidsLimit: number
    tmpfsSize: string
    workspace: string
    apiUrl: string
  }
}

export type RunService = ReturnType<typeof createRunService>

export function createRunService(options: RunServiceOptions) {
  const { db, dataDir, containerManager, platformService, configStore } =
    options
  const queries = createRunQueries({ db, dataDir })
  const bridges = new Map<string, PtyBridge>()
  const locks = new Map<string, Promise<unknown>>()
  const pending = new Map<string, PendingOutcome>()
  let closed = false
  const now = () => new Date().toISOString()

  function withLock<T>(runId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run service is closed")
      )
    }
    const previous = locks.get(runId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(op)
    locks.set(runId, next)
    return next.finally(() => {
      if (locks.get(runId) === next) locks.delete(runId)
    }) as Promise<T>
  }

  const runDir = (runId: string) => join(dataDir, RUNS_SUBDIR, runId)
  const workspaceAbs = (runId: string) => join(runDir(runId), "workspace")
  const piAgentAbs = (runId: string) => join(runDir(runId), "pi-agent")
  const containerName = (runId: string) => `aegisx-run-${runId}`

  function requireRun(runId: string) {
    const run = queries.get(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    return run
  }

  function updateRow(runId: string, patch: Record<string, unknown>) {
    db.update(runs).set(patch).where(eq(runs.id, runId)).run()
  }

  /** Watch a launched/reattached container; finalize the run when pi exits. */
  function watchExit(runId: string) {
    const name = containerName(runId)
    void containerManager
      .wait(name)
      .then((result) => finalize(runId, result.StatusCode))
      .catch(() => finalize(runId, -1))
  }

  function attachBridge(runId: string, stream: NodeJS.ReadWriteStream) {
    const bridge = createPtyBridge({
      runId,
      containerName: containerName(runId),
      stream,
      manager: containerManager,
    })
    bridges.set(runId, bridge)
  }

  function finalize(runId: string, exitCode: number) {
    void withLock(runId, () => {
      const row = queries.getRow(runId)
      if (row?.status !== "running") return
      const outcome = pending.get(runId)
      pending.delete(runId)
      const ts = now()
      let status: string
      let summary: string | null = row.summary
      let error: string | null = null
      if (outcome?.mode === "finish") {
        status = "completed"
        summary = outcome.summary || summary
      } else if (outcome?.mode === "stop") {
        status = "stopped"
      } else if (exitCode === 0) {
        status = "completed"
      } else {
        status = "failed"
        error = `pi exited with code ${exitCode}`
      }
      updateRow(runId, {
        status,
        summary,
        error,
        completedAt: ts,
        updatedAt: ts,
      })
      const bridge = bridges.get(runId)
      if (bridge) {
        bridge.dispose()
        bridges.delete(runId)
      }
    })
  }

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  async function create(input: CreateRunInput): Promise<RunPublic> {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, input.challengeId))
      .get()
    if (!challenge) {
      throw new RunActionError("not_found", "Challenge not found")
    }
    const model = input.provider.models.find((m) => m.id === input.modelId)
    if (!model?.enabled || !input.provider.enabled) {
      throw new RunActionError("invalid_state", "Model is unavailable")
    }
    if (!input.provider.apiKey) {
      throw new RunActionError("invalid_state", "Provider API key is required")
    }

    const runId = crypto.randomUUID()
    return withLock(runId, async () => {
      const name = containerName(runId)
      const wsAbs = workspaceAbs(runId)
      const piAbs = piAgentAbs(runId)
      mkdirSync(wsAbs, { recursive: true })
      mkdirSync(piAbs, { recursive: true })
      mkdirSync(join(piAbs, "sessions"), { recursive: true })

      const remote = getChallengeRemote(db, input.challengeId)
      const challengeAttachments = copyAttachments(
        db,
        dataDir,
        input.challengeId,
        wsAbs
      )

      const env: EnvironmentConfig = {
        type: "container",
        image: input.container.image,
        cpus: input.container.cpus,
        memoryMb: input.container.memoryMb,
        pidsLimit: input.container.pidsLimit,
      }
      const modelConfig: ModelConfig = {
        provider: input.provider.label,
        providerLabel: input.provider.label,
        modelId: model.modelId,
        modelLabel: model.label,
        thinkingLevel: input.thinkingLevel,
      }

      const promptContext = buildPromptContext(
        {
          runId,
          challenge,
          remote,
          challengeAttachments,
          environment: env,
          model: modelConfig,
        },
        db,
        input.container.workspace
      )
      const templates = resolvePromptTemplates(options.getSettings())
      const appendSystem = renderSystemPrompt(
        templates.mainSystemPromptTemplate,
        promptContext
      )
      const initialPrompt = renderInitialPrompt(
        templates.initialPromptTemplate,
        promptContext
      )

      generatePiAgentVolume({
        piAgentDir: piAbs,
        providers: providers(),
        appendSystem,
        targetSupported: promptContext.run.targetSupported,
      })

      const modelRef = piModelRefFor(input.provider, input.modelId)
      const cmd = buildPiCmd({
        modelRef: modelRef.ref,
        thinkingLevel: input.thinkingLevel,
        challengeName: challenge.name,
        initialPrompt,
      })
      const containerEnv = buildContainerEnv({
        runId,
        challengeId: challenge.id,
        challengeName: challenge.name,
        apiUrl: input.container.apiUrl,
      })

      const ts = now()
      db.insert(runs)
        .values({
          id: runId,
          challengeId: challenge.id,
          status: "running",
          launcher: "pi",
          provider: modelConfig.provider,
          providerLabel: modelConfig.providerLabel ?? null,
          modelId: modelConfig.modelId,
          modelLabel: modelConfig.modelLabel ?? null,
          piModelRef: modelRef.ref,
          thinkingLevel: modelConfig.thinkingLevel,
          image: env.image,
          cpus: env.cpus,
          memoryMb: env.memoryMb,
          pidsLimit: env.pidsLimit,
          containerName: name,
          workspacePath: relative(dataDir, wsAbs),
          createdAt: ts,
          startedAt: ts,
          updatedAt: ts,
        })
        .run()

      let launched: { id: string; stream: NodeJS.ReadWriteStream }
      try {
        launched = await containerManager.launch({
          name,
          image: env.image,
          cmd,
          env: containerEnv,
          workingDir: input.container.workspace,
          binds: [
            `${wsAbs}:${input.container.workspace}`,
            `${piAbs}:/root/.pi/agent`,
          ],
          limits: {
            cpus: env.cpus,
            memoryMb: env.memoryMb,
            pidsLimit: env.pidsLimit,
          },
          tmpfsSize: input.container.tmpfsSize,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateRow(runId, {
          status: "failed",
          error: `Failed to start container: ${message}`,
          completedAt: now(),
          updatedAt: now(),
        })
        throw new RunActionError("launch_failed", message)
      }

      attachBridge(runId, launched.stream)
      watchExit(runId)
      discoverSessionLater(runId, piAbs)
      return requireRun(runId)
    })
  }

  function discoverSessionLater(runId: string, piAbs: string) {
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      const { sessionId, sessionFile } = discoverPiSessionId(piAbs)
      if (sessionId) {
        clearInterval(timer)
        updateRow(runId, {
          piSessionId: sessionId,
          piSessionFile: sessionFile,
          updatedAt: now(),
        })
      } else if (attempts > 30) {
        clearInterval(timer)
      }
    }, 2000)
  }

  function stop(runId: string) {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      pending.set(runId, { mode: "stop" })
      await containerManager.kill(containerName(runId), "SIGTERM")
      return requireRun(runId)
    })
  }

  function finish(runId: string, summary: string) {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      pending.set(runId, { mode: "finish", summary })
      await containerManager.kill(containerName(runId), "SIGTERM")
      return requireRun(runId)
    })
  }

  function resume(runId: string) {
    return withLock(runId, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      if (row.status === "running") {
        throw new RunActionError("invalid_state", "Run is already running")
      }
      if (!row.piSessionId || !row.piModelRef) {
        throw new RunActionError(
          "invalid_state",
          "Run has no pi session to resume"
        )
      }
      const settings = options.getSettings()
      const run = requireRun(runId)
      const cmd = buildPiCmd({
        modelRef: row.piModelRef,
        thinkingLevel: row.thinkingLevel as ThinkingLevel,
        challengeName: run.challengeName,
        session: row.piSessionId,
      })
      const containerEnv = buildContainerEnv({
        runId,
        challengeId: row.challengeId,
        challengeName: run.challengeName,
        apiUrl: defaultApiUrl(),
      })
      const launched = await containerManager.launch({
        name: row.containerName,
        image: row.image,
        cmd,
        env: containerEnv,
        workingDir: settings["container.workspace"],
        binds: [
          `${workspaceAbs(runId)}:${settings["container.workspace"]}`,
          `${piAgentAbs(runId)}:/root/.pi/agent`,
        ],
        limits: {
          cpus: row.cpus,
          memoryMb: row.memoryMb,
          pidsLimit: row.pidsLimit,
        },
        tmpfsSize: settings["container.tmpfsSize"],
      })
      attachBridge(runId, launched.stream)
      const ts = now()
      updateRow(runId, {
        status: "running",
        startedAt: ts,
        completedAt: null,
        error: null,
        updatedAt: ts,
      })
      watchExit(runId)
      return requireRun(runId)
    })
  }

  async function deleteRun(runId: string) {
    await withLock(runId, async () => {
      const row = queries.getRow(runId)
      if (!row) throw new RunActionError("not_found", "Run not found")
      if (row.status === "running") {
        throw new RunActionError(
          "invalid_state",
          "Stop the run before deleting it"
        )
      }
      await containerManager.remove(row.containerName)
      const bridge = bridges.get(runId)
      if (bridge) {
        bridge.dispose()
        bridges.delete(runId)
      }
      rmSync(runDir(runId), { recursive: true, force: true })
      db.delete(runs).where(eq(runs.id, runId)).run()
    })
  }

  function refresh(runId: string): RunPublic | undefined {
    return queries.get(runId)
  }

  async function recoverOnBoot() {
    const rows = db.select().from(runs).all()
    for (const row of rows) {
      if (row.status !== "running") continue
      const name = row.containerName
      if (await containerManager.isRunning(name)) {
        try {
          const stream = await containerManager.reattach(name)
          attachBridge(row.id, stream)
          watchExit(row.id)
        } catch {
          updateRow(row.id, {
            status: "failed",
            error: "Container was running but could not be reattached",
            completedAt: now(),
            updatedAt: now(),
          })
        }
      } else {
        updateRow(row.id, {
          status: "stopped",
          completedAt: now(),
          updatedAt: now(),
        })
      }
    }
  }

  async function close() {
    closed = true
    await Promise.allSettled([...locks.values()])
    locks.clear()
    for (const bridge of bridges.values()) bridge.dispose()
    bridges.clear()
  }

  function defaultApiUrl() {
    return `http://host.docker.internal:${process.env.PORT ?? 3000}`
  }

  return {
    create,
    stop,
    finish,
    resume,
    delete: deleteRun,
    refresh,
    recoverOnBoot,
    close,
    get: queries.get,
    listForEvent: queries.listForEvent,
    listForChallenge: queries.listForChallenge,
    workspacePath: queries.workspacePath,
    ptyBridge: (runId: string) => bridges.get(runId),
    submitFlag: platformService.submitFlag,
    targetAction: platformService.targetAction,
  }
}
