import { rmSync } from "node:fs"

import type {
  AgentDetail,
  AgentSummary,
  FleetInfo,
  SwitchModelInput,
  WorkspaceFile,
  WorkspaceInfo,
} from "@aegisx/shared"
import { formatModelRef, get } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import { and, eq, inArray, ne } from "drizzle-orm"

import { applyModelSwitch } from "../agents/agent-ops"
import { createAgentHost } from "../agents/host"
import type { AgentLoopSettings } from "../agents/host-session"
import {
  chainLock,
  createSessionLifecycle,
  type SessionLifecycle,
} from "../agents/lifecycle"
import { createLiveBus, type LiveBus } from "../agents/live"
import type { Database } from "../db"
import { agents, challengeFlags, challenges } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import {
  readWorkspacePath,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { refreshBuiltinTemplateSections } from "../orchestration/prompt-refresh-v19"
import { seedBuiltinTemplates } from "../orchestration/prompt-templates"
import {
  getChallengeRemote,
  isTargetCapable,
} from "../platforms/challenge-state"
import type { createPlatformService } from "../platforms/service"
import { getProviderConnections } from "../providers/public"
import { createAgentFactory, type AgentFactory } from "./agent-factory"
import { createAgentSessionOps } from "./agent-session-ops"
import { createAgentStatus, type AgentStatus } from "./agent-status"
import {
  createChannelService,
  orchKey,
  teamKey,
  type ChannelService,
} from "./channels"
import {
  createContainerLifecycle,
  type ContainerLifecycle,
} from "./container-lifecycle"
import type { ContainerManager } from "./container/container-manager"
import { createAgentDeadlines, type AgentDeadlines } from "./deadlines"
import { RunActionError } from "./errors"
import { createModelResolver } from "./model-resolver"
import { parseAgentToolDefinitions, parseAgentTools } from "./public"
import { createAgentQueries } from "./queries"
import {
  createQueueService,
  parseSpawnQueueParams,
  type QueueService,
} from "./queue"
import { createSchedulerAdmin, type SchedulerAdmin } from "./scheduler-admin"
import { createStallWatchdog, type StallWatchdog } from "./stall-watchdog"
import {
  challengeRoot,
  orchestratorKey,
  orchestratorRoot,
  workspaceDir as workspaceDirOf,
} from "./workspace-resolver"

type PlatformService = ReturnType<typeof createPlatformService>

export type AgentServiceOptions = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  platformService: PlatformService
  configStore: ConfigStore
  getSettings(): import("@aegisx/shared").FlatSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost?: typeof createAgentHost
  /** Test seam: grace between deadline-abort and a forced dispose. */
  timeoutGraceMs?: number
  /** Test seam: container idle-sweep cadence. */
  sweepIntervalMs?: number
  /** Test seam: container idle TTL. */
  idleTtlMs?: number
  /** Test seam: channel flush tick interval (default 5min). */
  flushIntervalMs?: number
  /** Test seam: stall watchdog threshold (default 2min). */
  stallMs?: number
}

export type SendMessageInput = {
  text: string
  /** Only meaningful while the agent is streaming (steer/followUp). */
  deliverAs?: "steer" | "followUp"
}

export type AgentService = ReturnType<typeof createAgentService>

export function createAgentService(options: AgentServiceOptions) {
  const { db, dataDir, containerManager, platformService, configStore } =
    options
  const createHost = options.createHost ?? createAgentHost
  const getSettings = () => options.getSettings()

  function providers(): ProviderConnection[] {
    return getProviderConnections(configStore)
  }

  /** Model-ref resolution, factored out of the service (model-resolver.ts). */
  const modelResolver = createModelResolver({
    getSettings,
    providers,
  })
  const queries = createAgentQueries({ db })
  const bus: LiveBus = createLiveBus()

  // Seed the four built-in prompt templates (idempotent) so the service is
  // self-sufficient — any agent spawned here renders. Then apply the one-time
  // v19 section refresh (user-edited sections keep their edits).
  seedBuiltinTemplates(db)
  refreshBuiltinTemplateSections(db)
  // Idempotent guard: plugin-owned template rows (a pre-v9 concept) must
  // never come back — re-delete any who got re-seeded.
  db.run(`DELETE FROM prompt_templates WHERE plugin != 'builtin'`)

  /** Per-agent promise-chaining locks (the only concurrency mechanism). */
  const locks = new Map<string, Promise<unknown>>()
  /** Global fence lock: serializes fence check + slot reservation across all
   * spawns so the concurrency caps hold under interleaving. */
  const fenceLocks = new Map<string, Promise<unknown>>()
  /** finish_run winners: agentId → summary (consumed at turn settle). */
  const pendingFinish = new Map<string, string>()
  /** Agents finish_run already warned about a missing flag (once each). */
  const finishFlagWarned = new Set<string>()
  let closed = false
  /** Monotonic timestamp: never returns the same value twice, so agents
   * declared within one millisecond still get a strictly-ordered `createdAt`. */
  let lastNowMs = 0
  const now = () => {
    let ms = Date.now()
    if (ms <= lastNowMs) ms = lastNowMs + 1
    lastNowMs = ms
    return new Date(ms).toISOString()
  }

  function withLock<T>(agentId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Agent service is closed")
      )
    }
    return chainLock(locks, agentId, op)
  }

  /** Global fence critical section. Serializes the fence check + slot
   * reservation so concurrent spawns can't overshoot the caps. Holds only
   * the quick DB op (row insert); container builds and setup run outside.
   *
   * Lock order: every fence critical section (spawn) runs OUTSIDE any agent
   * lock — no fence section ever acquires an agent lock, so the order is
   * acyclic (no deadlock). */
  async function withFence<T>(op: () => T | Promise<T>): Promise<T> {
    return chainLock(fenceLocks, "global-fence", op)
  }

  const challengeWorkspaceRoot = (eventId: string, challengeId: string) =>
    workspaceDirOf(challengeRoot(dataDir, eventId, challengeId))

  function updateAgent(
    agentId: string,
    patch: Partial<typeof agents.$inferInsert>
  ) {
    db.update(agents).set(patch).where(eq(agents.id, agentId)).run()
  }

  function requireAgent(agentId: string): AgentSummary {
    const agent = queries.getAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    return agent
  }

  // --- unified message layer ------------------------------------------------

  const channels: ChannelService = createChannelService({
    db,
    dataDir,
    bus,
    lifecycle: () => lifecycle,
    now,
    challengeWorkspaceRoot,
    ...(options.flushIntervalMs !== undefined
      ? { flushIntervalMs: options.flushIntervalMs }
      : {}),
  })

  const stallWatchdog: StallWatchdog = createStallWatchdog({
    db,
    channels,
    isSchedulerPaused: (eventId) => schedulerAdmin.isSchedulerPaused(eventId),
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
  })

  const status: AgentStatus = createAgentStatus({
    db,
    queries,
    bus,
    channels,
    isSchedulerPaused: (eventId) => schedulerAdmin.isSchedulerPaused(eventId),
    onAgentSettled: (agentId) => stallWatchdog.noteAgentIdle(agentId),
    now,
    updateAgent,
    queue: () => queue,
  })

  // Late-bound module refs: the factories below reference each other. None
  // of the closures run during construction — they are all assigned before
  // the service is usable.
  let factory!: AgentFactory
  let schedulerAdmin!: SchedulerAdmin
  let queue: QueueService | undefined

  /** Force terminal after a timeout grace: dispose the stuck session and
   * mark the agent aborted (the shared container is NEVER killed). */
  function forceAbortAgent(agentId: string): void {
    const session = lifecycle.get(agentId)
    if (session) {
      void session.dispose()
      lifecycle.delete(agentId)
    }
    status.terminalizeAgent(agentId, { status: "aborted" })
    bus.forget([agentId])
  }

  const lifecycle: SessionLifecycle = createSessionLifecycle({
    kind: "agent",
    withLock,
    onTurnStart(agentId) {
      status.agentTurnStart(agentId)
    },
    onTurnSettled(agentId, error) {
      const pending = pendingFinish.get(agentId)
      if (pending !== undefined) {
        // finish_run's graceful self-termination: dispose the session and
        // land the agent terminal with its summary.
        pendingFinish.delete(agentId)
        finishFlagWarned.delete(agentId)
        const session = lifecycle.get(agentId)
        if (session) {
          void session.dispose()
          lifecycle.delete(agentId)
        }
        deadlines.clearAgentTimers(agentId)
        status.terminalizeAgent(agentId, {
          status: "completed",
          summary: pending,
          event: "agent.finished",
        })
        return
      }
      status.agentTurnSettled(agentId, error)
    },
    onBeforeNewTurn(agentId) {
      pendingFinish.delete(agentId)
    },
    async onResume(agentId) {
      await factory.resumeAgent(agentId)
    },
  })

  function agentSettings(): AgentLoopSettings {
    const s = getSettings()
    return {
      compaction: { enabled: get(s, "agent.compactionEnabled") },
      retry: {
        enabled: get(s, "agent.retryEnabled"),
        maxRetries: get(s, "agent.retryMaxRetries"),
      },
    }
  }

  // Per-agent hard-deadline timers (deadlines.ts).
  const deadlines: AgentDeadlines = createAgentDeadlines({
    lifecycle,
    updateAgent,
    now,
    forceTerminal: forceAbortAgent,
    emitAgentEvent: status.emitAgentEvent,
    timeoutGraceMs: options.timeoutGraceMs,
  })

  // Per-challenge container lifecycle (lazy create + idle TTL sweep; the
  // scheduler container is managed by its agent's lifecycle).
  const containerLifecycle: ContainerLifecycle = createContainerLifecycle({
    db,
    containerManager,
    ...(options.sweepIntervalMs !== undefined
      ? { sweepIntervalMs: options.sweepIntervalMs }
      : {}),
    ...(options.idleTtlMs !== undefined
      ? { idleTtlMs: options.idleTtlMs }
      : {}),
  })

  // --- multi-session + flat backtrack (v12) --------------------------------
  const sessionOps = createAgentSessionOps({
    db,
    lifecycle,
    withLock,
    prepareAgent: (agentId) => factory.prepareAgent(agentId),
    updateAgent,
    emitAgent: status.emitAgent,
    requireAgent,
    now,
  })

  // --- agent facade (routes-facing) -----------------------------------------

  /** Spawn one solver agent (the direct path — fence full → capacity
   * error). The queue's drainer calls the factory directly. */
  async function spawn(input: {
    eventId: string
    challengeId: string
    model?: string
    prompt?: string
    promptMode?: "strategy" | "override"
    timeoutMs?: number
    source?: "manual" | "scheduler"
  }): Promise<AgentSummary> {
    const agentId = await factory.spawnAgent({
      eventId: input.eventId,
      challengeId: input.challengeId,
      role: "solver",
      model: input.model,
      prompt: input.prompt,
      promptMode: input.promptMode,
      timeoutMs: input.timeoutMs,
      source: input.source ?? "manual",
    })
    return requireAgent(agentId)
  }

  /** Per-agent stop: abort the current turn; it settles to idle (the shared
   * container stays warm). */
  async function stopAgent(agentId: string): Promise<AgentSummary> {
    await lifecycle.abort(agentId).catch(() => undefined)
    return requireAgent(agentId)
  }

  /** Terminal close (user/scheduler): abort + dispose the session, land
   * aborted. Files and the DB session survive (reopen on demand). */
  async function closeAgent(agentId: string): Promise<AgentSummary> {
    const agent = requireAgent(agentId)
    if (
      agent.status === "completed" ||
      agent.status === "aborted" ||
      agent.status === "failed"
    ) {
      throw new RunActionError("invalid_state", "Agent is already closed")
    }
    await withLock(agentId, async () => {
      const session = lifecycle.get(agentId)
      if (session?.session.isStreaming) {
        await session.session.abort().catch(() => undefined)
      }
      if (session) {
        void session.dispose()
        lifecycle.delete(agentId)
      }
      deadlines.clearAgentTimers(agentId)
      pendingFinish.delete(agentId)
      finishFlagWarned.delete(agentId)
      status.terminalizeAgent(agentId, { status: "aborted" })
      bus.forget([agentId])
    })
    return requireAgent(agentId)
  }

  /** Force-finish (HTTP /finish): the sanctioned terminal transition with a
   * summary. Idempotent on an already-completed agent. */
  async function finishAgent(
    agentId: string,
    summary: string
  ): Promise<AgentSummary> {
    const agent = requireAgent(agentId)
    if (agent.status === "completed") return agent
    if (agent.status === "aborted" || agent.status === "failed") {
      throw new RunActionError("invalid_state", "Agent is already closed")
    }
    await withLock(agentId, async () => {
      const session = lifecycle.get(agentId)
      if (session?.session.isStreaming) {
        await session.session.abort().catch(() => undefined)
      }
      if (session) {
        void session.dispose()
        lifecycle.delete(agentId)
      }
      deadlines.clearAgentTimers(agentId)
      pendingFinish.delete(agentId)
      finishFlagWarned.delete(agentId)
      status.terminalizeAgent(agentId, {
        status: "completed",
        summary,
        event: "agent.finished",
      })
      bus.forget([agentId])
    })
    return requireAgent(agentId)
  }

  /** Per-agent message — a DIRECT lifecycle.send (no channel row, no double
   * bookkeeping). Three-state semantics: streaming → steer at turn end,
   * idle → fresh turn, terminal → onResume reopen. */
  async function sendMessage(
    agentId: string,
    input: SendMessageInput
  ): Promise<AgentSummary> {
    await lifecycle.send(agentId, input.text, input.deliverAs)
    return requireAgent(agentId)
  }

  /** Per-agent model switch: takes effect next turn; persists the snapshot
   * on the agent row. Serialized on the agent's lock against its turns. */
  function switchAgentModel(
    agentId: string,
    input: SwitchModelInput
  ): Promise<AgentSummary> {
    return withLock(agentId, async () => {
      const session = lifecycle.get(agentId)
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Agent has no live session; send it a message first"
        )
      }
      const agentRow = queries.getAgentRow(agentId)
      // Proactively refresh the workspace's ModelRuntime when the config
      // changed since it was last refreshed, so the resolved target carries
      // the current provider/apiKey/metadata — not a frozen snapshot. (This
      // also makes models added while live resolvable, so there is no longer
      // a miss-then-retry fallback.)
      await factory.ensureWorkspaceRuntimeFresh(
        factory.workspaceKeyOf(agentRow ?? { eventId: "", challengeId: null })
      )
      let result: Awaited<ReturnType<typeof applyModelSwitch>>
      try {
        result = await applyModelSwitch(
          session,
          providers(),
          input.model,
          agentRow?.model ?? null
        )
      } catch (error) {
        throw new RunActionError(
          "invalid_state",
          error instanceof Error ? error.message : String(error)
        )
      }
      const { target } = result
      // Persist the ACTUAL (SDK-clamped) thinking level so the agent
      // snapshot matches runtime reality.
      updateAgent(agentId, {
        model: formatModelRef(
          target.provider,
          target.model,
          result.thinkingLevel
        ),
        updatedAt: now(),
      })
      status.emitAgent(agentId)
      return requireAgent(agentId)
    })
  }

  /** Replace an agent's steer/followUp queue. Serialized against its turns;
   * uses the SDK queue API directly. */
  function setQueue(
    agentId: string,
    input: { steering: string[]; followUp: string[] }
  ): Promise<void> {
    return withLock(agentId, async () => {
      const session = lifecycle.get(agentId)
      if (!session) return
      session.session.clearQueue()
      for (const text of input.steering) {
        const trimmed = text.trim()
        if (trimmed) await session.session.steer(trimmed)
      }
      for (const text of input.followUp) {
        const trimmed = text.trim()
        if (trimmed) await session.session.followUp(trimmed)
      }
    })
  }

  /** Manually compact an agent's context (pi SDK `session.compact()`). */
  async function compactAgent(agentId: string): Promise<AgentSummary> {
    await withLock(agentId, async () => {
      const session = lifecycle.get(agentId)
      if (!session) {
        throw new RunActionError(
          "invalid_state",
          "Agent session is not active — send a message first"
        )
      }
      if (session.session.isStreaming) {
        throw new RunActionError(
          "invalid_state",
          "Cannot compact while a turn is running — stop it first"
        )
      }
      await session.session.compact()
    })
    return requireAgent(agentId)
  }

  /** Set / extend / shorten an agent's hard deadline; re-arms the live
   * timer. Usable on terminal agents (pre-sets the next reopen). */
  function setAgentTimeout(agentId: string, timeoutMs: number): AgentSummary {
    const agent = schedulerAdmin.setAgentTimeout(
      agentId,
      timeoutMs,
      updateAgent
    )
    const row = queries.getAgentRow(agentId)
    if (row && (row.status === "running" || row.status === "idle")) {
      deadlines.armAgentTimers(agentId, row.deadlineAt)
    }
    status.emitAgent(agentId)
    return agent
  }

  /** Full agent detail (the AgentDialog view). */
  function getAgentDetail(agentId: string): AgentDetail | undefined {
    const row = queries.getAgentRow(agentId)
    if (!row) return undefined
    const agent = requireAgent(agentId)
    const workspace = workspaceInfoOf(row)
    return {
      agent,
      tools: parseAgentTools(row.tools),
      toolDefinitions: parseAgentToolDefinitions(row.toolDefinitions),
      systemPrompt: row.systemPrompt,
      sessionFile: row.sessionFile,
      usage: queries.usageOfAgent(agentId),
      workspace,
    }
  }

  function workspaceInfoOf(row: typeof agents.$inferSelect): WorkspaceInfo {
    const s = getSettings()
    const key = row.challengeId ?? orchestratorKey(row.eventId)
    // containerRunning is inherently async (docker inspect) — the fleet
    // polls every few seconds and a stale registry read is acceptable; a
    // registered container is treated as running.
    return {
      containerRunning: containerLifecycle.registered(key),
      liveAgentCount: liveAgentCountOf(row.challengeId),
      image: get(s, "container.image"),
      cpus: get(s, "container.cpus"),
      memoryMb: get(s, "container.memoryMb"),
      pidsLimit: get(s, "container.pidsLimit"),
    }
  }

  function liveAgentCountOf(challengeId: string | null): number {
    if (!challengeId) {
      const row = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.role, "orchestrator"),
            inArray(agents.status, ["running", "idle"])
          )
        )
        .get()
      return row ? 1 : 0
    }
    return db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challengeId),
          inArray(agents.status, ["running", "idle"])
        )
      )
      .all().length
  }

  /** The fleet view: challenges + per-challenge agents + scheduler agent +
   * config/status (the event overview's single poll). */
  function fleet(eventId: string): FleetInfo {
    const challengeRows = db
      .select({
        id: challenges.id,
        name: challenges.name,
        category: challenges.category,
      })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    const solverAgents = queries.listAgents({ eventId, role: "solver" })
    const agentsByChallenge: Record<string, AgentSummary[]> = {}
    for (const agent of solverAgents) {
      if (!agent.challengeId) continue
      const list = agentsByChallenge[agent.challengeId] ?? []
      list.push(agent)
      agentsByChallenge[agent.challengeId] = list
    }
    return {
      challenges: challengeRows,
      agentsByChallenge,
      schedulerAgent: schedulerAdmin.getSchedulerAgent(eventId) ?? null,
      config: schedulerAdmin.getSchedulerConfig(eventId),
      status: schedulerAdmin.getStatusSnapshot(eventId),
    }
  }

  /** Challenge workspace file tree (agents/ shared/ attachments/ visible). */
  function workspaceFiles(
    eventId: string,
    challengeId: string,
    path: string
  ): WorkspaceFile {
    return readWorkspacePath(challengeWorkspaceRoot(eventId, challengeId), path)
  }

  function workspaceDownloadPath(
    eventId: string,
    challengeId: string,
    path: string
  ) {
    return workspaceDownload(challengeWorkspaceRoot(eventId, challengeId), path)
  }

  // --- agent deletion ---------------------------------------------------------

  /** Delete one agent: dispose its live session, drop the row (cascades its
   * sessions), sweep its dm channel data. Workspaces persist (challenge
   * property). */
  async function deleteAgent(agentId: string): Promise<void> {
    await withLock(agentId, async () => {
      const row = queries.getAgentRow(agentId)
      if (!row) throw new RunActionError("not_found", "Agent not found")
      const session = lifecycle.get(agentId)
      if (session?.session.isStreaming) {
        await session.session.abort().catch(() => undefined)
      }
      if (session) {
        void session.dispose()
        lifecycle.delete(agentId)
      }
      deadlines.clearAgentTimers(agentId)
      pendingFinish.delete(agentId)
      finishFlagWarned.delete(agentId)
      channels.cleanupAgentChannels(agentId)
      bus.forget([agentId])
      if (row.role === "orchestrator") {
        containerLifecycle.removeContainer(orchestratorKey(row.eventId))
      }
      db.delete(agents).where(eq(agents.id, agentId)).run()
    })
  }

  /** Event-settings bulk purge: delete every agent of the event in scope —
   * the scheduler agent first (scope=all) so it stops reacting to the
   * teardowns that follow. Challenge workspaces persist (challenge
   * property; delete the challenges to clear them). */
  async function deleteAgentsForEvent(
    eventId: string,
    scope: "solver" | "all"
  ): Promise<void> {
    const rows = db
      .select({ id: agents.id, role: agents.role })
      .from(agents)
      .where(
        scope === "all"
          ? eq(agents.eventId, eventId)
          : and(eq(agents.eventId, eventId), eq(agents.role, "solver"))
      )
      .all()
    const ordered = [
      ...rows.filter((row) => row.role === "orchestrator"),
      ...rows.filter((row) => row.role !== "orchestrator"),
    ]
    for (const row of ordered) {
      await deleteAgent(row.id)
    }
  }

  // --- flag hooks -------------------------------------------------------------

  /** Platform-side hook: a flag was accepted — notify the event's scheduler
   * (agent.flagAccepted) and stop the challenge's other live agents
   * (同题已完全解出 — the submitter finishes its write-up via finish_run),
   * cancel the challenge's pending queue items, stop the target when
   * orphaned. Idempotent. */
  function notifyFlagAccepted(
    challengeId: string,
    submitterAgentId?: string
  ): void {
    if (submitterAgentId) {
      status.emitAgentEvent(submitterAgentId, {
        type: "agent.flagAccepted",
        agentId: submitterAgentId,
      })
    }
    stopOthersOnSolved(challengeId, submitterAgentId)
  }

  /** Platform-side hook: a correct-but-incomplete multi-flag submission
   * (TSecBench partial — the challenge is NOT fully solved). ONE non-urgent
   * system post into the challenge's #team + a non-urgent orch notice. */
  function notifyFlagPartial(
    challengeId: string,
    message: string | null,
    _submitterAgentId?: string
  ): void {
    const name =
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()?.name ?? challengeId
    const confirmed = db
      .select({ flag: challengeFlags.flag })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.status, "accepted")
        )
      )
      .all()
      .map((f) => f.flag)
    const text =
      `多 flag 进度：「${name}」部分解出${message ? `（${message}）` : ""}。` +
      `已确认：${confirmed.join("、") || "（无）"}。` +
      `请专注剩余 flag；已确认的无需重复提交。`
    const eventId = db
      .select({ eventId: challenges.eventId })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()?.eventId
    channels.post({
      channelKey: teamKey(challengeId),
      author: { type: "system" },
      body: text,
      meta: { eventType: "flagPartial" },
    })
    if (eventId) {
      postOrchNotice(
        eventId,
        `部分解出：「${name}」${message ?? "多 flag 未集齐"}`
      )
    }
  }

  /** Non-urgent system notice into orch:<eventId> (rides the next flush;
   * paused → silently dropped). */
  function postOrchNotice(eventId: string, line: string): void {
    if (schedulerAdmin.isSchedulerPaused(eventId)) return
    channels.post({
      channelKey: orchKey(eventId),
      author: { type: "system" },
      body: line,
      meta: { noticeType: "notice" },
    })
  }

  /** Full-solve cleanup (see notifyFlagAccepted). */
  function stopOthersOnSolved(
    challengeId: string,
    submitterAgentId?: string
  ): void {
    const eventId = db
      .select({ eventId: challenges.eventId })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()?.eventId
    if (!eventId) return
    const name =
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()?.name ?? challengeId
    // Other live agents on the challenge: terminal close (aborted). The
    // submitter keeps its session to finish the write-up via finish_run.
    const siblings = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.challengeId, challengeId),
          inArray(agents.status, ["running", "idle"]),
          submitterAgentId ? ne(agents.id, submitterAgentId) : undefined
        )
      )
      .all()
    for (const sibling of siblings) {
      void closeAgent(sibling.id).catch(() => undefined)
    }
    const cancelled = queue
      ? queue.cancelPendingForChallenge(eventId, challengeId)
      : 0
    // Orphaned platform target: the challenge is fully solved — its target
    // is no longer needed (the submitter finishes its write-up without it).
    if (isTargetCapable(getChallengeRemote(db, challengeId))) {
      void platformService
        .targetAction(challengeId, "stop")
        .catch(() => undefined)
    }
    const parts: string[] = []
    if (siblings.length > 0)
      parts.push(`已停止 ${siblings.length} 个同题 agent`)
    if (cancelled > 0) parts.push(`已取消 ${cancelled} 个排队项`)
    if (parts.length > 0) {
      postOrchNotice(eventId, `「${name}」已完全解出：${parts.join("；")}`)
    }
  }

  // --- scheduler (event orchestrator) lifecycle -------------------------------

  /** Wake text sent on resume / reopen so the orchestrator re-syncs. */
  const SCHEDULER_RESUME_MESSAGE =
    "调度已恢复。请重新同步状态（aegisx.snapshot()）后再行动。"

  /** Start (or restart) the event's scheduler agent from its config. The
   * orchestrator's model is the per-event `scheduler_config.modelId`
   * override when set, else the global default.
   *
   *  - live scheduler agent: paused → resume (un-pause + wake); else error.
   *  - terminal scheduler agent: reopen — wake it (onResume → resumeAgent:
   *    container + session rebuilt, memory kept). `reset: true` deletes the
   *    row and spawns fresh.
   *  - no scheduler agent: fresh spawn (also clears paused). */
  async function startScheduler(
    eventId: string,
    opts: { reset?: boolean } = {}
  ): Promise<AgentSummary> {
    const config = schedulerAdmin.getSchedulerConfig(eventId)
    const existing = schedulerAdmin.getSchedulerAgent(eventId)
    if (
      existing &&
      (existing.status === "running" || existing.status === "idle")
    ) {
      if (config.paused) {
        await resumeScheduler(eventId)
        return requireAgent(existing.id)
      }
      throw new RunActionError(
        "invalid_state",
        "A scheduler agent is already active for this event"
      )
    }
    if (existing && !opts.reset) {
      // Reopen keeps memory — wake the orchestrator (onResume → resumeAgent:
      // container + session rebuilt, session kept).
      schedulerAdmin.setSchedulerPaused(eventId, false)
      await sendMessage(existing.id, { text: SCHEDULER_RESUME_MESSAGE })
      return requireAgent(existing.id)
    }
    if (existing && opts.reset) {
      await deleteAgent(existing.id)
    }
    schedulerAdmin.setSchedulerPaused(eventId, false)
    const agentId = await factory.spawnAgent({
      eventId,
      challengeId: null,
      role: "orchestrator",
      source: "manual",
    })
    return requireAgent(agentId)
  }

  /** Disable the scheduler (W3): set paused=1 (the event gate drops its
   * agent-lifecycle notifications) + abort the current turn (the container
   * stays warm — scheduler containers are lifecycle-managed, never swept). */
  async function pauseScheduler(eventId: string): Promise<AgentSummary | null> {
    schedulerAdmin.setSchedulerPaused(eventId, true)
    const sched = schedulerAdmin.getSchedulerAgent(eventId)
    if (sched && (sched.status === "running" || sched.status === "idle")) {
      await stopAgent(sched.id)
      return requireAgent(sched.id)
    }
    return null
  }

  /** Re-enable the scheduler (W3): set paused=0 + tell the orchestrator to
   * re-sync before acting. No-op messaging when absent/terminal (the flag is
   * still written). */
  async function resumeScheduler(
    eventId: string
  ): Promise<AgentSummary | null> {
    schedulerAdmin.setSchedulerPaused(eventId, false)
    const sched = schedulerAdmin.getSchedulerAgent(eventId)
    if (sched && (sched.status === "running" || sched.status === "idle")) {
      await sendMessage(sched.id, { text: SCHEDULER_RESUME_MESSAGE })
      return requireAgent(sched.id)
    }
    return null
  }

  /** Close the scheduler agent (terminal aborted) + remove its container. */
  async function closeScheduler(eventId: string): Promise<AgentSummary> {
    const sched = schedulerAdmin.getSchedulerAgent(eventId)
    if (!sched) throw new RunActionError("not_found", "No scheduler agent")
    const result = await closeAgent(sched.id)
    containerLifecycle.removeContainer(orchestratorKey(eventId))
    return result
  }

  // --- construction of the factory + queue -------------------------------------

  factory = createAgentFactory({
    db,
    dataDir,
    containerManager,
    containerLifecycle,
    platformService,
    providers,
    configVersion: () => configStore.configVersion,
    modelResolver,
    queries,
    bus,
    channels,
    pendingFinish,
    finishFlagWarned,
    lifecycle,
    withFence,
    getSettings,
    now,
    updateAgent,
    status,
    deadlines: () => deadlines,
    queue: () => queue,
    agentSettings,
    createHost,
    getSchedulerConfig: (eventId) => schedulerAdmin.getSchedulerConfig(eventId),
    ...(options.timeoutGraceMs !== undefined
      ? { timeoutGraceMs: options.timeoutGraceMs }
      : {}),
  })

  schedulerAdmin = createSchedulerAdmin({
    db,
    queries,
    getSettings,
    now,
    providers,
    modelResolver,
  })

  // The queue's drainer spawns one agent per item from the item's snapshot.
  queue = createQueueService({
    db,
    getSettings,
    isDisposed: () => closed,
    launch: async (item) => {
      const params = parseSpawnQueueParams(item.params)
      return factory.spawnAgent({
        eventId: item.eventId,
        challengeId: item.challengeId,
        role: "solver",
        model: params.model,
        prompt: params.prompt ?? (item.prompt || undefined),
        promptMode: params.promptMode,
        timeoutMs: item.timeoutMs ?? undefined,
        source: item.source as "manual" | "scheduler",
        queueItemId: item.id,
      })
    },
    onQueueEmergency: (eventId, line) => {
      if (schedulerAdmin.isSchedulerPaused(eventId)) return
      channels.post({
        channelKey: orchKey(eventId),
        author: { type: "system" },
        body: line,
        meta: { noticeType: "emergency" },
        urgent: true,
      })
    },
    onQueueNotice: (eventId, line) => postOrchNotice(eventId, line),
  })

  async function close(): Promise<void> {
    closed = true
    await Promise.allSettled(locks.values())
    locks.clear()
    for (const timer of deadlines.timeoutTimers.values()) {
      if (timer.deadline) clearTimeout(timer.deadline)
      if (timer.grace) clearTimeout(timer.grace)
    }
    deadlines.timeoutTimers.clear()
    containerLifecycle.close()
    queue?.cancelDrain()
    await lifecycle.closeAll()
    pendingFinish.clear()
    finishFlagWarned.clear()
    stallWatchdog.close()
    channels.close()
    bus.close()
  }

  /** Remove a challenge's workspace tree (agents/ shared/ attachments/
   * sessions/ runtime/) — called on challenge deletion. Idempotent. */
  function deleteChallengeWorkspace(
    eventId: string,
    challengeId: string
  ): void {
    rmSync(challengeRoot(dataDir, eventId, challengeId), {
      recursive: true,
      force: true,
    })
  }

  /** Remove the orchestrator workspace tree — called on event deletion /
   * scheduler reset. Idempotent. */
  function deleteSchedulerWorkspace(eventId: string): void {
    rmSync(orchestratorRoot(dataDir, eventId), {
      recursive: true,
      force: true,
    })
  }

  /** Remove every challenge workspace + the orchestrator workspace of the
   * event on event deletion. Idempotent per directory. */
  function deleteEventWorkspaces(eventId: string): void {
    const challengeRows = db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    for (const { id } of challengeRows) {
      rmSync(challengeRoot(dataDir, eventId, id), {
        recursive: true,
        force: true,
      })
    }
    deleteSchedulerWorkspace(eventId)
  }

  return {
    spawn,
    getAgent: queries.getAgent,
    getAgentDetail,
    listAgents: queries.listAgents,
    fleet,
    stopAgent,
    closeAgent,
    finishAgent,
    sendMessage,
    switchAgentModel,
    compactAgent,
    setQueue,
    setAgentTimeout,
    listAgentSessions: sessionOps.listAgentSessions,
    createAgentSession: sessionOps.createAgentSession,
    activateAgentSession: sessionOps.activateAgentSession,
    backtrackAgent: sessionOps.backtrackAgent,
    delete: deleteAgent,
    deleteAgentsForEvent,
    getStatus: schedulerAdmin.getStatusSnapshot,
    getSchedulerAgent: schedulerAdmin.getSchedulerAgent,
    inboxSnapshot: channels.inboxSnapshot,
    setInboxDeliveryPaused: (eventId: string, paused: boolean) =>
      channels.setDeliveryPaused(eventId, paused),
    assertModelsResolvable: schedulerAdmin.assertModelsResolvable,
    getSchedulerConfig: schedulerAdmin.getSchedulerConfig,
    upsertSchedulerConfig: schedulerAdmin.upsertSchedulerConfig,
    startScheduler,
    pauseScheduler,
    resumeScheduler,
    closeScheduler,
    queue: () => queue!,
    refresh: queries.getAgent,
    recoverOnBoot: factory.recoverOnBoot,
    close,
    listMessages: queries.listMessages,
    usageOfAgent: queries.usageOfAgent,
    usageForEvent: queries.usageForEvent,
    agentFlags: queries.agentFlags,
    bus,
    channels,
    notifyFlagAccepted,
    notifyFlagPartial,
    submitFlag: platformService.submitFlag,
    targetAction: platformService.targetAction,
    workspaceFiles,
    workspaceDownloadPath,
    deleteChallengeWorkspace,
    deleteSchedulerWorkspace,
    deleteEventWorkspaces,
    containerLifecycle,
  }
}
