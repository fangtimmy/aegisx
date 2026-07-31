import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { eq } from "drizzle-orm"
import type {
  EnvironmentConfig,
  FlatSettings,
  ModelConfig,
  RunPublic,
  RunSession,
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
import { listPiSessions, type PiSessionFile } from "./container-manager"
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
  apiUrl: string
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
  }
}

export type RunService = ReturnType<typeof createRunService>

export function createRunService(options: RunServiceOptions) {
  const {
    db,
    dataDir,
    apiUrl,
    containerManager,
    platformService,
    configStore,
  } = options
  const queries = createRunQueries({ db, dataDir })
  const bridges = new Map<string, PtyBridge>()
  const forceKillTimers = new Map<string, NodeJS.Timeout>()
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
      .catch((error) => {
        console.error("Container wait failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
        finalize(runId, -1)
      })
  }

  function clearForceKillTimer(runId: string) {
    const timer = forceKillTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      forceKillTimers.delete(runId)
    }
  }

  /** SIGTERM first; force SIGKILL after a grace period if pi hasn't exited. */
  function terminateContainer(runId: string) {
    const name = containerName(runId)
    clearForceKillTimer(runId)
    const timer = setTimeout(() => {
      forceKillTimers.delete(runId)
      void containerManager
        .isRunning(name)
        .then((running) =>
          running
            ? containerManager.kill(name, "SIGKILL").catch(() => undefined)
            : undefined
        )
        .catch(() => undefined)
    }, 10_000)
    forceKillTimers.set(runId, timer)
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
      clearForceKillTimer(runId)
      const bridge = bridges.get(runId)
      if (bridge) {
        bridge.dispose()
        bridges.delete(runId)
      }
      // Pre-warm session HTML for replay (pi has flushed its jsonl on exit).
      void exportSessionHtml(runId).catch((error) => {
        console.error("Session export failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
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
      const childContext = {
        ...promptContext,
        agent: {
          role: "child" as const,
          isMain: false,
          name: "Child agent",
          task: null,
        },
      }
      const appendChildSystem = renderSystemPrompt(
        templates.childSystemPromptTemplate,
        childContext
      )
      const initialPrompt = renderInitialPrompt(
        templates.initialPromptTemplate,
        promptContext
      )

      generatePiAgentVolume({
        piAgentDir: piAbs,
        providers: providers(),
        appendSystem,
        appendChildSystem,
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
        apiUrl,
        modelRef: modelRef.ref,
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
      return requireRun(runId)
    })
  }

  function stop(runId: string) {
    return withLock(runId, async () => {
      const run = requireRun(runId)
      if (run.status !== "running") {
        throw new RunActionError("invalid_state", "Run is not running")
      }
      pending.set(runId, { mode: "stop" })
      await containerManager.kill(containerName(runId), "SIGTERM")
      terminateContainer(runId)
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
      terminateContainer(runId)
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
      if (!row.piModelRef) {
        throw new RunActionError("invalid_state", "Run has no model to resume")
      }
      // `pi -c` continues the most recent session in this run's exclusive
      // pi-agent volume; require at least one session jsonl to exist.
      if (listPiSessions(piAgentAbs(runId)).length === 0) {
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
        continue: true,
      })
      const containerEnv = buildContainerEnv({
        runId,
        challengeId: row.challengeId,
        challengeName: run.challengeName,
        apiUrl,
        modelRef: row.piModelRef,
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
      // Drop cached replay HTML; the session keeps writing and is re-exported.
      rmSync(sessionsHtmlDir(runId), { recursive: true, force: true })
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

  const sessionsHtmlDir = (runId: string) =>
    join(runDir(runId), "sessions-html")

  /** Parse a session jsonl header + count messages for the session list. */
  function parseSessionMeta(session: PiSessionFile): RunSession {
    let name: string | null = null
    let createdAt: string | null = null
    let messageCount = 0
    try {
      const text = readFileSync(session.sessionPath, "utf8")
      for (const line of text.split("\n")) {
        if (!line) continue
        let entry: { type?: string; name?: string; timestamp?: string }
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.type === "session" && entry.timestamp) {
          createdAt = entry.timestamp
        } else if (entry.type === "session_info" && entry.name) {
          name = entry.name
        } else if (entry.type === "message") {
          messageCount += 1
        }
      }
    } catch {
      /* unreadable jsonl — fall back to file metadata */
    }
    return {
      id: session.sessionId,
      name: name ?? session.file,
      createdAt: createdAt ?? new Date(session.mtime).toISOString(),
      modifiedAt: new Date(session.mtime).toISOString(),
      messageCount,
    }
  }

  function listSessions(runId: string): RunSession[] {
    return listPiSessions(piAgentAbs(runId)).map(parseSessionMeta)
  }

  /** Export every session jsonl to sessions-html/<id>.html (pre-warm). */
  async function exportSessionHtml(runId: string) {
    const sessions = listPiSessions(piAgentAbs(runId))
    if (sessions.length === 0) return
    const outDir = sessionsHtmlDir(runId)
    mkdirSync(outDir, { recursive: true })
    await Promise.allSettled(
      sessions.map(async (session) => {
        const out = join(outDir, `${session.sessionId}.html`)
        const proc = Bun.spawn(["pi", "--export", session.sessionPath, out], {
          stdout: "ignore",
          stderr: "pipe",
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text()
          console.error("Session export failed", {
            runId,
            sessionId: session.sessionId,
            exitCode,
            stderr,
          })
        }
      })
    )
  }

  /** Return the cached replay HTML path, exporting on demand if missing. */
  async function sessionHtmlPath(
    runId: string,
    sessionId: string
  ): Promise<string | null> {
    const out = join(sessionsHtmlDir(runId), `${sessionId}.html`)
    if (existsSync(out)) return out
    const session = listPiSessions(piAgentAbs(runId)).find(
      (s) => s.sessionId === sessionId
    )
    if (!session) return null
    mkdirSync(sessionsHtmlDir(runId), { recursive: true })
    const proc = Bun.spawn(["pi", "--export", session.sessionPath, out], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    return existsSync(out) ? out : null
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
    for (const timer of forceKillTimers.values()) clearTimeout(timer)
    forceKillTimers.clear()
    for (const bridge of bridges.values()) bridge.dispose()
    bridges.clear()
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
    workspacePath: queries.workspacePath,
    runDirPath: queries.runDirPath,
    listSessions,
    sessionHtmlPath,
    ptyBridge: (runId: string) => bridges.get(runId),
    submitFlag: platformService.submitFlag,
    targetAction: platformService.targetAction,
  }
}
