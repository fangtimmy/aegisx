import { copyFileSync, mkdirSync } from "node:fs"
import { basename, dirname, extname, join, relative } from "node:path"
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
import { and, count, desc, eq, isNull } from "drizzle-orm"
import { Type } from "typebox"
import {
  containerName,
  createContainer,
  createContainerTools,
  removeContainer,
} from "./container"
import type { createDatabase } from "./db"
import { attachments, challenges, events, runAgents, runs } from "./db/schema"
import { summarizeUsage, sumUsage } from "./usage"

type Database = ReturnType<typeof createDatabase>["db"]
type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"
export type AgentStatus = RunStatus
type RunEvent =
  | { type: "status"; run: RunPublic }
  | { type: "agent_status"; agent: AgentPublic }
  | { type: "agent_event"; agentId: string; event: AgentSessionEvent }
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
  providerLabel?: string
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

export type AgentPublic = {
  id: string
  runId: string
  parentAgentId: string | null
  name: string
  status: AgentStatus
  summary: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
}

type Options = {
  db: Database
  dataDir: string
  maxConcurrency: number
  authStorage?: AuthStorage
  modelRegistry?: ModelRegistry
  resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined
  getApiKeys?: (provider: string) => Iterable<string>
}

type CurrentSession = {
  runId: string
  agentId: string
  session: AgentSession
  unsubscribe: () => void
}

const terminalStatuses: RunStatus[] = ["completed", "failed", "stopped"]

export function createRunManager(options: Options) {
  const { db, dataDir } = options
  let maxConcurrency = options.maxConcurrency
  const authStorage = options.authStorage ?? AuthStorage.create()
  const modelRegistry =
    options.modelRegistry ?? ModelRegistry.inMemory(authStorage)
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
  db.update(runAgents)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(eq(runAgents.status, "running"))
    .run()
  const runsWithAgents = new Set(
    db
      .select({ runId: runAgents.runId })
      .from(runAgents)
      .all()
      .map(({ runId }) => runId)
  )
  for (const run of db.select().from(runs).all()) {
    if (runsWithAgents.has(run.id)) continue
    db.insert(runAgents)
      .values({
        id: run.id,
        runId: run.id,
        parentAgentId: null,
        name: "Main agent",
        task: null,
        status: run.status,
        sessionPath: run.sessionPath,
        summary: run.summary,
        error: run.error,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
      })
      .run()
  }
  for (const { id } of interruptedContainers) removeContainer(containerName(id))

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

  function getAgentPublic(agentId: string): AgentPublic | undefined {
    const agent = getStoredAgent(agentId)
    if (!agent) return undefined
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
      provider: config.providerLabel ?? config.provider ?? "",
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

  function releaseAgent(agentId: string) {
    const active = current.get(agentId)
    if (active) {
      active.unsubscribe()
      active.session.dispose()
      current.delete(agentId)
    }
  }

  function releaseRun(runId: string) {
    for (const active of [...current.values()]) {
      if (active.runId === runId) releaseAgent(active.agentId)
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

  function updateAgent(
    agentId: string,
    values: Partial<typeof runAgents.$inferInsert>
  ): AgentPublic {
    db.update(runAgents)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(runAgents.id, agentId))
      .run()
    const agent = getAgentPublic(agentId)
    if (!agent) throw new Error("Agent not found")
    emit(agent.runId, { type: "agent_status", agent })
    return agent
  }

  function runningCount() {
    return (
      db
        .select({ value: count() })
        .from(runAgents)
        .where(eq(runAgents.status, "running"))
        .get()?.value ?? 0
    )
  }

  function requireCapacity(count = 1) {
    if (runningCount() + count > maxConcurrency) {
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

  function agentWorkspacePath(
    run: typeof runs.$inferSelect,
    agent: typeof runAgents.$inferSelect
  ) {
    if (!run.workspacePath)
      throw new RunStartError("Run workspace is unavailable")
    const root = join(dataDir, run.workspacePath)
    return agent.parentAgentId ? join(root, "agents", agent.id) : root
  }

  function agentContainerPath(agent: typeof runAgents.$inferSelect) {
    return agent.parentAgentId ? `/workspace/agents/${agent.id}` : "/workspace"
  }

  async function ensureSession(agentId: string) {
    const existing = current.get(agentId)
    if (existing) return existing.session
    const agent = getStoredAgent(agentId)
    const run = agent ? getStored(agent.runId) : undefined
    if (!agent || !run || !agent.sessionPath) {
      throw new RunStartError("Agent session is unavailable")
    }
    const modelConfig = parseModelConfig(run.modelConfig)
    const model = await resolveRequestedModel(modelConfig)
    const apiKey = await authStorage.getApiKey(modelConfig.provider, {
      includeFallback: false,
    })
    const workspacePath = agentWorkspacePath(run, agent)
    const sessionFile = join(dataDir, agent.sessionPath)
    const sessionManager = SessionManager.open(
      sessionFile,
      dirname(sessionFile),
      workspacePath
    )
    return attachSession(
      agent,
      run,
      workspacePath,
      sessionManager,
      model,
      parseEnvironment(run.environmentConfig),
      apiKey,
      modelConfig.provider
    )
  }

  async function attachSession(
    agent: typeof runAgents.$inferSelect,
    run: typeof runs.$inferSelect,
    workspacePath: string,
    sessionManager: SessionManager,
    model: Model<Api>,
    environment: EnvironmentConfig,
    apiKey: string | undefined,
    provider: string
  ) {
    const runId = run.id
    const agentId = agent.id
    const isMain = agent.parentAgentId === null
    let environmentTools: ReturnType<typeof createContainerTools> | undefined
    if (environment.type === "container") {
      let name = activeContainers.get(runId)
      if (!name) {
        name = containerName(runId)
        if (!run.workspacePath) {
          throw new RunStartError("Run workspace is unavailable")
        }
        try {
          createContainer(
            name,
            join(dataDir, run.workspacePath),
            environment.image,
            environment
          )
        } catch {
          throw new RunStartError("Container could not be started")
        }
        activeContainers.set(runId, name)
      }
      environmentTools = createContainerTools(name, agentContainerPath(agent))
    }
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
        updateAgent(agentId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary: params.summary,
          error: null,
        })
        for (const child of listStoredAgents(runId)) {
          if (
            child.id !== agentId &&
            !terminalStatuses.includes(child.status as AgentStatus)
          ) {
            updateAgent(child.id, {
              status: "stopped",
              completedAt: new Date().toISOString(),
            })
          }
        }
        void abortRun(runId).finally(() => releaseRun(runId))
        return {
          content: [{ type: "text" as const, text: "Run completed" }],
          details: {},
        }
      },
    })
    const spawnAgent = defineTool({
      name: "spawn_agent",
      label: "Spawn agent",
      description:
        "Start a background child agent for a focused task with an isolated context",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 80 }),
        task: Type.String({ minLength: 1, maxLength: 100_000 }),
      }),
      executionMode: "parallel",
      execute: async (_id, params, signal) => {
        if (signal?.aborted) throw new Error("Sub-agent creation was aborted")
        const child = await createChildAgent(
          runId,
          agentId,
          params.name.trim(),
          params.task.trim(),
          signal
        )
        return {
          content: [
            {
              type: "text" as const,
              text: `Started ${child.name} in the background with agent ID ${child.id}`,
            },
          ],
          details: { agentId: child.id, status: child.status },
        }
      },
    })
    const inspectAgent = defineTool({
      name: "inspect_agent",
      label: "Inspect agent",
      description:
        "Read the current status and latest output summary of a child agent",
      parameters: Type.Object({
        agent_id: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, params) => {
        const child = getStoredAgent(params.agent_id)
        if (child?.runId !== runId || child.parentAgentId !== agentId) {
          return {
            content: [
              { type: "text" as const, text: "Child agent was not found" },
            ],
            details: { found: false },
          }
        }
        const value = getAgentPublic(child.id) as AgentPublic
        const summary =
          value.summary ?? lastAssistantText(historyForAgent(child.id))
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: value.id,
                name: value.name,
                status: value.status,
                summary,
                error: value.error,
              }),
            },
          ],
          details: { found: true },
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
    const hostTools = isMain
      ? [
          finishRun,
          spawnAgent,
          inspectAgent,
          unavailable("start_target"),
          unavailable("stop_target"),
          unavailable("submit_flag"),
        ]
      : []
    let created: Awaited<ReturnType<typeof createAgentSession>>
    try {
      created = await createAgentSession({
        cwd:
          environment.type === "container"
            ? agentContainerPath(agent)
            : workspacePath,
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
                ...(isMain
                  ? [
                      "finish_run",
                      "spawn_agent",
                      "inspect_agent",
                      "start_target",
                      "stop_target",
                      "submit_flag",
                    ]
                  : []),
              ],
              customTools: hostTools,
            }),
        sessionManager,
        settingsManager: SettingsManager.inMemory(),
      })
    } catch (error) {
      releaseAgent(agentId)
      throw error
    }
    const session = created.session
    const secrets = new Set(options.getApiKeys?.(provider))
    if (apiKey) secrets.add(apiKey)
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end") {
        for (const secret of options.getApiKeys?.(provider) ?? []) {
          secrets.add(secret)
        }
        for (const secret of secrets) redactSecret(event.message, secret)
      }
      emit(runId, { type: "agent_event", agentId, event })
    })
    current.set(agentId, { runId, agentId, session, unsubscribe })
    return session
  }

  function startMainPrompt(
    runId: string,
    agentId: string,
    session: AgentSession,
    message: string
  ) {
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
          updateAgent(agentId, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: "Agent session failed",
          })
          for (const child of listStoredAgents(runId)) {
            if (
              child.id !== agentId &&
              !terminalStatuses.includes(child.status as AgentStatus)
            ) {
              updateAgent(child.id, {
                status: "stopped",
                completedAt: new Date().toISOString(),
              })
            }
          }
          void abortRun(runId)
        }
      })
      .finally(() => {
        if (closed) return
        const run = getStored(runId)
        if (run && terminalStatuses.includes(run.status as RunStatus)) {
          releaseRun(runId)
        }
      })
  }

  function startChildPrompt(
    runId: string,
    agentId: string,
    session: AgentSession,
    message: string
  ) {
    void session
      .prompt(message)
      .then(async () => {
        if (closed) return
        const agent = getStoredAgent(agentId)
        if (agent?.status !== "running") return
        const summary = lastAssistantText(historyForAgent(agentId))
        const completed = updateAgent(agentId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary,
          error: null,
        })
        await notifyMain(completed)
      })
      .catch(async () => {
        if (closed || aborting.has(runId)) return
        const agent = getStoredAgent(agentId)
        if (agent?.status !== "running") return
        const failed = updateAgent(agentId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "Agent session failed",
        })
        await notifyMain(failed)
      })
      .finally(() => releaseAgent(agentId))
  }

  async function abortRun(runId: string) {
    await Promise.allSettled(
      [...current.values()]
        .filter((active) => active.runId === runId)
        .map((active) => active.session.abort())
    )
  }

  function historyForAgent(agentId: string): SessionEntry[] {
    const agent = getStoredAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    if (!agent.sessionPath) return []
    return redactFlags(
      SessionManager.open(join(dataDir, agent.sessionPath)).getEntries()
    )
  }

  function lastAssistantText(entries: SessionEntry[]) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry.type !== "message" || entry.message.role !== "assistant") {
        continue
      }
      const content = entry.message.content
      const text = (Array.isArray(content) ? content : [content])
        .flatMap((part) => {
          if (typeof part === "string") return [part]
          return part.type === "text" ? [part.text] : []
        })
        .join("\n")
        .trim()
      if (text) return text.slice(0, 50_000)
    }
    return null
  }

  async function notifyMain(agent: AgentPublic) {
    if (closed) return
    const run = getStored(agent.runId)
    const main = getMainAgent(agent.runId)
    if (run?.status !== "running" || !main || main.status !== "running") return
    const session = current.get(main.id)?.session
    if (!session) return
    const result =
      agent.summary ?? agent.error ?? "No final output was produced."
    const message = [
      `Background agent ${agent.name} (${agent.id}) ${agent.status}.`,
      "Final output:",
      result,
    ].join("\n\n")
    if (session.isStreaming) await session.steer(message)
    else startMainPrompt(run.id, main.id, session, message)
  }

  async function createChildAgent(
    runId: string,
    parentAgentId: string,
    name: string,
    task: string,
    signal?: AbortSignal
  ) {
    const run = getStored(runId)
    const parent = getStoredAgent(parentAgentId)
    if (
      run?.status !== "running" ||
      !parent ||
      parent.runId !== runId ||
      parent.parentAgentId !== null
    ) {
      throw new RunActionError(
        "invalid_state",
        "Run state does not allow a child agent"
      )
    }
    if (!run.workspacePath) {
      throw new RunActionError("invalid_state", "Run workspace is unavailable")
    }
    requireCapacity()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const workspacePath = join(dataDir, run.workspacePath, "agents", id)
    const sessionDir = join(dataDir, "sessions", runId, id)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    const sessionManager = SessionManager.create(workspacePath, sessionDir, {
      id,
    })
    const sessionFile = sessionManager.getSessionFile()
    if (!sessionFile) throw new Error("Persistent session was not created")
    db.insert(runAgents)
      .values({
        id,
        runId,
        parentAgentId,
        name,
        task,
        status: "running",
        sessionPath: relative(dataDir, sessionFile),
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run()
    emit(runId, {
      type: "agent_status",
      agent: getAgentPublic(id) as AgentPublic,
    })

    const requireRunning = () => {
      if (
        signal?.aborted ||
        getStored(runId)?.status !== "running" ||
        getStoredAgent(id)?.status !== "running"
      ) {
        throw new RunStartError("Child agent start was interrupted")
      }
    }

    try {
      const modelConfig = parseModelConfig(run.modelConfig)
      const model = await resolveRequestedModel(modelConfig)
      requireRunning()
      const apiKey = await authStorage.getApiKey(modelConfig.provider, {
        includeFallback: false,
      })
      requireRunning()
      const agent = getStoredAgent(id) as typeof runAgents.$inferSelect
      const session = await attachSession(
        agent,
        run,
        workspacePath,
        sessionManager,
        model,
        parseEnvironment(run.environmentConfig),
        apiKey,
        modelConfig.provider
      )
      if (
        signal?.aborted ||
        getStored(runId)?.status !== "running" ||
        getStoredAgent(id)?.status !== "running"
      ) {
        await session.abort()
        releaseAgent(id)
        throw new RunStartError("Child agent start was interrupted")
      }
      const prompt = [
        "You are a background child agent working on one delegated CTF task.",
        `Delegated task: ${task}`,
        "You may inspect the whole Run workspace, but write your artifacts only in your current working directory.",
        "You cannot finish the Run or create more agents. Return a concise, evidence-based final answer for the main agent.",
        "Run context:",
        run.prompt,
      ].join("\n\n")
      startChildPrompt(runId, id, session, prompt)
      return getAgentPublic(id) as AgentPublic
    } catch (error) {
      if (
        !aborting.has(runId) &&
        getStored(runId)?.status === "running" &&
        getStoredAgent(id)?.status === "running"
      ) {
        updateAgent(id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error:
            error instanceof RunStartError
              ? error.message
              : "Agent session failed",
        })
      }
      releaseAgent(id)
      throw error
    }
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
        workspacePath: relative(dataDir, workspacePath),
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(runAgents)
      .values({
        id,
        runId: id,
        parentAgentId: null,
        name: "Main agent",
        task: null,
        status: "running",
        sessionPath: relative(dataDir, sessionFile),
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run()

    try {
      const model = await resolveRequestedModel(modelConfig)
      const apiKey = await authStorage.getApiKey(modelConfig.provider, {
        includeFallback: false,
      })
      const agent = getStoredAgent(id) as typeof runAgents.$inferSelect
      const run = getStored(id) as typeof runs.$inferSelect
      const session = await attachSession(
        agent,
        run,
        workspacePath,
        sessionManager,
        model,
        environment,
        apiKey,
        modelConfig.provider
      )
      startMainPrompt(id, id, session, prompt)
    } catch (error) {
      update(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
      updateAgent(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
      releaseRun(id)
    }
    return getPublic(id) as RunPublic
  }

  async function pause(runId: string) {
    requireMutable(runId, ["running"])
    aborting.set(runId, "paused")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalStatuses.includes(latest.status)) return latest
      const paused = update(runId, { status: "paused" })
      for (const agent of listStoredAgents(runId)) {
        if (agent.status === "running") {
          updateAgent(agent.id, { status: "paused" })
        }
      }
      releaseRun(runId)
      return paused
    } finally {
      aborting.delete(runId)
    }
  }

  async function resume(runId: string, message?: string) {
    requireMutable(runId, ["paused"])
    const pausedAgents = listStoredAgents(runId).filter(
      (agent) => agent.status === "paused"
    )
    const main = pausedAgents.find((agent) => agent.parentAgentId === null)
    if (!main)
      throw new RunActionError("invalid_state", "Main agent is unavailable")
    requireCapacity(pausedAgents.length)
    update(runId, { status: "running", error: null, completedAt: null })
    for (const agent of pausedAgents) {
      updateAgent(agent.id, {
        status: "running",
        error: null,
        completedAt: null,
      })
    }
    try {
      const session = await ensureSession(main.id)
      startMainPrompt(
        runId,
        main.id,
        session,
        message?.trim() ||
          "Continue solving the challenge from the current state."
      )
      for (const child of pausedAgents) {
        if (child.id === main.id) continue
        try {
          const childSession = await ensureSession(child.id)
          startChildPrompt(
            runId,
            child.id,
            childSession,
            "Continue the delegated task from the current state and report your final findings."
          )
        } catch (error) {
          const failed = updateAgent(child.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error:
              error instanceof RunStartError
                ? error.message
                : "Agent session failed",
          })
          await notifyMain(failed)
        }
      }
      return getPublic(runId) as RunPublic
    } catch (error) {
      const failed = update(runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          error instanceof RunStartError
            ? error.message
            : "Agent session failed",
      })
      updateAgent(main.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: failed.error,
      })
      for (const child of listStoredAgents(runId)) {
        if (!terminalStatuses.includes(child.status as AgentStatus)) {
          updateAgent(child.id, {
            status: "stopped",
            completedAt: new Date().toISOString(),
          })
        }
      }
      await abortRun(runId)
      releaseRun(runId)
      return failed
    }
  }

  async function message(runId: string, messageText: string) {
    const run = requireMutable(runId, ["running", "paused"])
    if (run.status === "paused") return resume(runId, messageText)
    const main = getMainAgent(runId)
    if (!main)
      throw new RunActionError("invalid_state", "Main agent is unavailable")
    const session = await ensureSession(main.id)
    if (session.isStreaming) await session.steer(messageText)
    else startMainPrompt(runId, main.id, session, messageText)
    return getPublic(runId) as RunPublic
  }

  async function stop(runId: string) {
    requireMutable(runId, ["running", "paused"])
    aborting.set(runId, "stopped")
    try {
      await abortRun(runId)
      const latest = getPublic(runId) as RunPublic
      if (terminalStatuses.includes(latest.status)) return latest
      const stopped = update(runId, {
        status: "stopped",
        completedAt: new Date().toISOString(),
      })
      for (const agent of listStoredAgents(runId)) {
        if (!terminalStatuses.includes(agent.status as AgentStatus)) {
          updateAgent(agent.id, {
            status: "stopped",
            completedAt: new Date().toISOString(),
          })
        }
      }
      releaseRun(runId)
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

  return {
    create,
    get: getPublic,
    agents: (runId: string) => {
      if (!getStored(runId)) {
        throw new RunActionError("not_found", "Run not found")
      }
      return listStoredAgents(runId).map(
        (agent) => getAgentPublic(agent.id) as AgentPublic
      )
    },
    agent: getAgentPublic,
    history: historyForAgent,
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
    agentUsage: (agentId: string) => {
      const agent = getStoredAgent(agentId)
      if (!agent) throw new RunActionError("not_found", "Agent not found")
      const run = getStored(agent.runId)
      if (!run) throw new RunActionError("not_found", "Run not found")
      return summarizeUsage(
        historyForAgent(agentId),
        parseModelConfig(run.modelConfig).costKnown !== false
      )
    },
    usage: (runId: string) => {
      const run = getStored(runId)
      if (!run) throw new RunActionError("not_found", "Run not found")
      const costKnown = parseModelConfig(run.modelConfig).costKnown !== false
      return sumUsage(
        listStoredAgents(runId).map((agent) =>
          summarizeUsage(historyForAgent(agent.id), costKnown)
        )
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
      ...(typeof parsed.providerLabel === "string"
        ? { providerLabel: parsed.providerLabel }
        : {}),
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

function redactSecret<T>(value: T, secret: string | undefined): T {
  if (!secret) return value
  if (typeof value === "string") {
    return value.replaceAll(secret, "[redacted]") as T
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = redactSecret(value[index], secret)
    }
    return value
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      const record = value as Record<string, unknown>
      record[key] = redactSecret(record[key], secret)
    }
  }
  return value
}
