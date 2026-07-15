import { copyFileSync, mkdirSync } from "node:fs"
import { basename, extname, join, relative } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai/compat"
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { count, desc, eq } from "drizzle-orm"
import { Type } from "typebox"
import {
  containerName,
  createContainer,
  createContainerTools,
  removeContainer,
} from "./container"
import type { createDatabase } from "./db"
import { attachments, challenges, events, runs } from "./db/schema"
import { summarizeUsage } from "./usage"

type Database = ReturnType<typeof createDatabase>["db"]
type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"
type RunEvent = AgentSessionEvent | { type: "status"; run: RunPublic }
type EnvironmentConfig =
  | { type: "local" }
  | {
      type: "container"
      image: string
      cpus: number
      memoryMb: number
      pidsLimit: number
    }
type ModelConfig = {
  provider: string
  modelId: string
  baseUrl?: string
  costKnown?: boolean
}

export type RunPublic = {
  id: string
  challengeId: string
  challengeName: string
  eventId: string
  status: RunStatus
  provider: string
  modelId: string
  environment: "local" | "container"
  image?: string | null
  cpus?: number
  memoryMb?: number
  pidsLimit?: number
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  error: string | null
  summary: string | null
  flag?: string | null
}

type Options = {
  db: Database
  dataDir: string
  maxConcurrency: number
  authStorage?: AuthStorage
  resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined
}

type CurrentSession = {
  session: AgentSession
  unsubscribe: () => void
}

const terminalStatuses: RunStatus[] = ["completed", "failed", "stopped"]

export function createRunManager(options: Options) {
  const { db, dataDir } = options
  let maxConcurrency = options.maxConcurrency
  const authStorage = options.authStorage ?? AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)
  const current = new Map<string, CurrentSession>()
  const activeContainers = new Map<string, string>()
  const listeners = new Map<string, Set<(event: RunEvent) => void>>()
  const aborting = new Map<string, "paused" | "stopped">()
  let closed = false

  const interruptedContainers = db
    .select({ id: runs.id, environmentConfig: runs.environmentConfig })
    .from(runs)
    .where(eq(runs.status, "running"))
    .all()
    .filter(
      ({ environmentConfig }) =>
        parseEnvironment(environmentConfig).type === "container"
    )
  db.update(runs)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(eq(runs.status, "running"))
    .run()
  for (const { id } of interruptedContainers) removeContainer(containerName(id))

  function getStored(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()
  }

  function getPublic(
    runId: string,
    includeFlag = false
  ): RunPublic | undefined {
    const row = db
      .select({ run: runs, challengeName: challenges.name, eventId: events.id })
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .innerJoin(events, eq(challenges.eventId, events.id))
      .where(eq(runs.id, runId))
      .get()
    if (!row) return undefined
    const config = parseModelConfig(row.run.modelConfig)
    const environment = parseEnvironment(row.run.environmentConfig)
    const value: RunPublic = {
      id: row.run.id,
      challengeId: row.run.challengeId,
      challengeName: row.challengeName,
      eventId: row.eventId,
      status: row.run.status as RunStatus,
      provider: config.provider ?? "",
      modelId: config.modelId ?? "",
      environment: environment.type,
      createdAt: row.run.createdAt,
      startedAt: row.run.startedAt,
      updatedAt: row.run.updatedAt,
      completedAt: row.run.completedAt,
      error: row.run.error,
      summary: row.run.summary,
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

  function emit(runId: string, event: RunEvent) {
    const safeEvent = redactFlags(event)
    for (const listener of listeners.get(runId) ?? []) listener(safeEvent)
  }

  function releaseSession(runId: string) {
    const active = current.get(runId)
    if (active) {
      active.unsubscribe()
      active.session.dispose()
      current.delete(runId)
    }
    const name = activeContainers.get(runId)
    if (name) {
      removeContainer(name)
      activeContainers.delete(runId)
    }
  }

  function update(
    runId: string,
    values: Partial<typeof runs.$inferInsert>
  ): RunPublic {
    db.update(runs)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()
    const run = getPublic(runId)
    if (!run) throw new Error("Run not found")
    emit(runId, { type: "status", run })
    return run
  }

  function runningCount() {
    return (
      db
        .select({ value: count() })
        .from(runs)
        .where(eq(runs.status, "running"))
        .get()?.value ?? 0
    )
  }

  function requireCapacity() {
    if (runningCount() >= maxConcurrency) {
      throw new RunActionError("capacity", "Run capacity reached")
    }
  }

  function buildPrompt(
    challenge: typeof challenges.$inferSelect,
    filenames: string[],
    environment: EnvironmentConfig
  ) {
    const optional = [
      challenge.category ? `Category: ${challenge.category}` : null,
      challenge.points === null ? null : `Points: ${challenge.points}`,
    ].filter(Boolean)
    return [
      `Challenge: ${challenge.name}`,
      ...optional,
      "",
      challenge.description,
      "",
      `Attachments: ${filenames.length ? filenames.join(", ") : "none"}`,
      environment.type === "container"
        ? "The current working directory is /workspace inside an isolated container. Keep all generated files there."
        : "The current working directory is this run's private workspace. Keep all generated files here.",
      "No external platform target or flag submission integration is available.",
      "When the challenge is solved, call finish_run with a concise summary and the optional flag. Do not continue working after that call.",
    ].join("\n")
  }

  function copyAttachments(
    challengeId: string,
    workspacePath: string
  ): string[] {
    const rows = db
      .select()
      .from(attachments)
      .where(eq(attachments.challengeId, challengeId))
      .orderBy(attachments.createdAt, attachments.id)
      .all()
    const used = new Set<string>()
    return rows.map((attachment) => {
      const original = basename(attachment.originalName) || "attachment"
      const extension = extname(original)
      const stem = original.slice(0, original.length - extension.length)
      let filename = original
      for (let suffix = 2; used.has(filename); suffix += 1) {
        filename = `${stem} (${suffix})${extension}`
      }
      used.add(filename)
      copyFileSync(
        join(dataDir, "attachments", ...attachment.storageKey.split("/")),
        join(workspacePath, filename)
      )
      return filename
    })
  }

  async function resolveRequestedModel(config: ModelConfig) {
    const model =
      options.resolveModel?.(config.provider, config.modelId) ??
      (config.baseUrl
        ? {
            id: config.modelId,
            name: config.modelId,
            api: "openai-completions" as const,
            provider: config.provider,
            baseUrl: config.baseUrl,
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8192,
          }
        : modelRegistry.find(config.provider, config.modelId))
    if (!model) {
      throw new RunStartError("Requested model is unavailable")
    }
    const auth = await modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok) {
      throw new RunStartError(
        "Credentials for the requested model are unavailable"
      )
    }
    return model
  }

  async function ensureSession(runId: string) {
    const existing = current.get(runId)
    if (existing) return existing.session
    const run = getStored(runId)
    if (!run?.workspacePath || !run.sessionPath) {
      throw new RunStartError("Run session is unavailable")
    }
    const modelConfig = parseModelConfig(run.modelConfig)
    const model = await resolveRequestedModel(modelConfig)
    const workspacePath = join(dataDir, run.workspacePath)
    const sessionFile = join(dataDir, run.sessionPath)
    const sessionManager = SessionManager.open(
      sessionFile,
      join(dataDir, "sessions", runId),
      workspacePath
    )
    return attachSession(
      runId,
      workspacePath,
      sessionManager,
      model,
      parseEnvironment(run.environmentConfig)
    )
  }

  async function attachSession(
    runId: string,
    workspacePath: string,
    sessionManager: SessionManager,
    model: Model<Api>,
    environment: EnvironmentConfig
  ) {
    let environmentTools: ReturnType<typeof createContainerTools> | undefined
    if (environment.type === "container") {
      const name = containerName(runId)
      try {
        createContainer(name, workspacePath, environment.image, environment)
      } catch {
        throw new RunStartError("Container could not be started")
      }
      activeContainers.set(runId, name)
      environmentTools = createContainerTools(name)
    }
    let session: AgentSession
    const finishRun = defineTool({
      name: "finish_run",
      label: "Finish run",
      description: "Mark this challenge run complete and stop further work",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1 }),
        flag: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        const stored = getStored(runId)
        if (!stored || terminalStatuses.includes(stored.status as RunStatus)) {
          return {
            content: [
              { type: "text" as const, text: "Run is already finished" },
            ],
            details: {},
          }
        }
        update(runId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary: params.summary,
          flag: params.flag ?? null,
          error: null,
        })
        void session.abort().finally(() => releaseSession(runId))
        return {
          content: [{ type: "text" as const, text: "Run completed" }],
          details: {},
        }
      },
    })
    const unavailable = (name: string) =>
      defineTool({
        name,
        label: name.replaceAll("_", " "),
        description: `${name.replaceAll("_", " ")} through the configured CTF platform`,
        parameters:
          name === "submit_flag"
            ? Type.Object({ flag: Type.String({ minLength: 1 }) })
            : Type.Object({}),
        execute: async () => ({
          content: [
            {
              type: "text" as const,
              text: "CTF platform integration is unavailable",
            },
          ],
          details: { available: false },
        }),
      })
    const hostTools = [
      finishRun,
      unavailable("start_target"),
      unavailable("stop_target"),
      unavailable("submit_flag"),
    ]
    let created: Awaited<ReturnType<typeof createAgentSession>>
    try {
      created = await createAgentSession({
        cwd: environment.type === "container" ? "/workspace" : workspacePath,
        authStorage,
        modelRegistry,
        model,
        ...(environmentTools
          ? {
              noTools: "builtin" as const,
              customTools: [...environmentTools, ...hostTools],
            }
          : {
              tools: [
                "read",
                "bash",
                "edit",
                "write",
                "grep",
                "find",
                "ls",
                "finish_run",
                "start_target",
                "stop_target",
                "submit_flag",
              ],
              customTools: hostTools,
            }),
        sessionManager,
        settingsManager: SettingsManager.inMemory(),
      })
    } catch (error) {
      releaseSession(runId)
      throw error
    }
    session = created.session
    const unsubscribe = session.subscribe((event) => emit(runId, event))
    current.set(runId, { session, unsubscribe })
    return session
  }

  function startPrompt(runId: string, session: AgentSession, message: string) {
    void session
      .prompt(message)
      .catch(() => {
        if (closed) return
        const run = getStored(runId)
        if (run?.status === "running" && !aborting.has(runId)) {
          update(runId, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: "Agent session failed",
          })
        }
      })
      .finally(() => {
        const run = getStored(runId)
        if (run && terminalStatuses.includes(run.status as RunStatus)) {
          releaseSession(runId)
        }
      })
  }

  async function create(
    challengeId: string,
    modelConfig: ModelConfig,
    environment: EnvironmentConfig = { type: "local" }
  ) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) throw new RunActionError("not_found", "Challenge not found")
    requireCapacity()

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const workspacePath = join(dataDir, "workspaces", id)
    const sessionDir = join(dataDir, "sessions", id)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    const filenames = copyAttachments(challengeId, workspacePath)
    const prompt = buildPrompt(challenge, filenames, environment)
    const sessionManager = SessionManager.create(workspacePath, sessionDir, {
      id,
    })
    const sessionFile = sessionManager.getSessionFile()
    if (!sessionFile) throw new Error("Persistent session was not created")
    db.insert(runs)
      .values({
        id,
        challengeId,
        status: "running",
        prompt,
        modelConfig: JSON.stringify(modelConfig),
        environmentConfig: JSON.stringify(environment),
        sessionPath: relative(dataDir, sessionFile),
        workspacePath: relative(dataDir, workspacePath),
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run()

    try {
      const model = await resolveRequestedModel(modelConfig)
      const session = await attachSession(
        id,
        workspacePath,
        sessionManager,
        model,
        environment
      )
      startPrompt(id, session, prompt)
    } catch (error) {
      update(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
    }
    return getPublic(id) as RunPublic
  }

  async function pause(runId: string) {
    const run = requireMutable(runId, ["running"])
    aborting.set(runId, "paused")
    try {
      await current.get(run.id)?.session.abort()
      const latest = getPublic(runId) as RunPublic
      if (terminalStatuses.includes(latest.status)) return latest
      const paused = update(runId, { status: "paused" })
      releaseSession(runId)
      return paused
    } finally {
      aborting.delete(runId)
    }
  }

  async function resume(runId: string, message?: string) {
    requireMutable(runId, ["paused"])
    requireCapacity()
    update(runId, { status: "running", error: null, completedAt: null })
    try {
      const session = await ensureSession(runId)
      startPrompt(
        runId,
        session,
        message?.trim() ||
          "Continue solving the challenge from the current state."
      )
      return getPublic(runId) as RunPublic
    } catch (error) {
      return update(runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
    }
  }

  async function message(runId: string, messageText: string) {
    const run = requireMutable(runId, ["running", "paused"])
    if (run.status === "paused") return resume(runId, messageText)
    const session = await ensureSession(runId)
    if (session.isStreaming) await session.steer(messageText)
    else startPrompt(runId, session, messageText)
    return getPublic(runId) as RunPublic
  }

  async function stop(runId: string) {
    const run = requireMutable(runId, ["running", "paused"])
    aborting.set(runId, "stopped")
    try {
      await current.get(run.id)?.session.abort()
      const latest = getPublic(runId) as RunPublic
      if (terminalStatuses.includes(latest.status)) return latest
      const stopped = update(runId, {
        status: "stopped",
        completedAt: new Date().toISOString(),
      })
      releaseSession(runId)
      return stopped
    } finally {
      aborting.delete(runId)
    }
  }

  function requireMutable(runId: string, allowed: RunStatus[]) {
    const run = getPublic(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    if (!allowed.includes(run.status)) {
      throw new RunActionError(
        "invalid_state",
        "Run state does not allow this action"
      )
    }
    return run
  }

  function history(runId: string): SessionEntry[] {
    const run = getStored(runId)
    if (!run) throw new RunActionError("not_found", "Run not found")
    if (!run.sessionPath) return []
    return redactFlags(
      SessionManager.open(join(dataDir, run.sessionPath)).getEntries()
    )
  }

  return {
    create,
    get: getPublic,
    history,
    listForEvent: (eventId: string) =>
      db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(challenges, eq(runs.challengeId, challenges.id))
        .where(eq(challenges.eventId, eventId))
        .orderBy(desc(runs.createdAt))
        .all()
        .map(({ id }) => getPublic(id) as RunPublic),
    listForChallenge: (challengeId: string) =>
      db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.challengeId, challengeId))
        .orderBy(desc(runs.createdAt))
        .all()
        .map(({ id }) => getPublic(id) as RunPublic),
    pause,
    resume,
    message,
    stop,
    subscribe: (runId: string, listener: (event: RunEvent) => void) => {
      const runListeners = listeners.get(runId) ?? new Set()
      runListeners.add(listener)
      listeners.set(runId, runListeners)
      return () => {
        runListeners.delete(listener)
        if (runListeners.size === 0) listeners.delete(runId)
      }
    },
    activeSessionCount: () => current.size,
    setMaxConcurrency: (value: number) => {
      maxConcurrency = value
    },
    workspacePath: (runId: string) => {
      const path = getStored(runId)?.workspacePath
      return path ? join(dataDir, path) : undefined
    },
    usage: (runId: string) => {
      const run = getStored(runId)
      if (!run) throw new RunActionError("not_found", "Run not found")
      const entries = run.sessionPath
        ? SessionManager.open(join(dataDir, run.sessionPath)).getEntries()
        : []
      return summarizeUsage(
        entries,
        parseModelConfig(run.modelConfig).costKnown !== false
      )
    },
    close: () => {
      if (closed) return
      closed = true
      for (const { session, unsubscribe } of current.values()) {
        unsubscribe()
        void session.abort()
        session.dispose()
      }
      current.clear()
      for (const name of activeContainers.values()) removeContainer(name)
      activeContainers.clear()
      listeners.clear()
    },
  }
}

function parseEnvironment(value: string): EnvironmentConfig {
  try {
    const parsed = JSON.parse(value) as Partial<EnvironmentConfig>
    if (parsed.type === "container" && typeof parsed.image === "string") {
      return {
        type: "container",
        image: parsed.image,
        cpus:
          "cpus" in parsed && typeof parsed.cpus === "number" ? parsed.cpus : 1,
        memoryMb:
          "memoryMb" in parsed && typeof parsed.memoryMb === "number"
            ? parsed.memoryMb
            : 512,
        pidsLimit:
          "pidsLimit" in parsed && typeof parsed.pidsLimit === "number"
            ? parsed.pidsLimit
            : 128,
      }
    }
  } catch {
    // Existing and malformed rows remain local rather than gaining container access.
  }
  return { type: "local" }
}

function parseModelConfig(value: string): ModelConfig {
  try {
    const parsed = JSON.parse(value) as Partial<ModelConfig>
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : "",
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : "",
      ...(typeof parsed.baseUrl === "string"
        ? { baseUrl: parsed.baseUrl }
        : {}),
      ...(parsed.costKnown === false ? { costKnown: false } : {}),
    }
  } catch {
    return { provider: "", modelId: "" }
  }
}

export class RunActionError extends Error {
  constructor(
    readonly code: "capacity" | "not_found" | "invalid_state",
    message: string
  ) {
    super(message)
  }
}

class RunStartError extends Error {}

function redactFlags<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === "flag" ? undefined : item))
  ) as T
}
