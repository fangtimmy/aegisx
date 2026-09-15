import type { AgentSummary, FlatSettings } from "@aegisx/shared"
import { formatModelRef, isTerminalAgentStatus } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { Database } from "../../db"
import type { Clock } from "../clock"
import type { ContainerManager } from "../container/container-manager"
import type { DomainEventActor } from "../domain-events/store"
import { emitDomainEvent } from "../domain-events/store"
import { RunActionError } from "../errors"
import { applyModelSwitch } from "../host/agent-ops"
import { createAgentHost } from "../host/host"
import type { AgentLoopSettings } from "../host/host-session"
import type { LiveBus } from "../host/live"
import { chainLock } from "../locks"
import type { ModelResolver } from "../model-resolver"
import type { AgentQueries } from "../queries"
import {
  agentContainerName,
  orchestratorContainerName,
} from "../workspace-resolver"
import {
  createAgentFactory,
  type KernelPlatform,
  type SpawnAdmission,
} from "./agent-factory"
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeDeps,
  type SendOutcome,
  type SettleOptions,
} from "./agent-runtime"
import { createAgentSessionOps } from "./agent-session-ops"
import {
  createAgentStatus,
  type AgentStatus,
  type LifecycleReactor,
} from "./agent-status"

export { fmtMs } from "./agent-runtime"
export type { SendOutcome, SettleOptions } from "./agent-runtime"
export type { LifecycleReactor, TerminalInfo } from "./agent-status"
export type { SpawnAdmission, SpawnAgentInput } from "./agent-factory"

export type AgentKernelDeps = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  /** The platform calls the agent's native tools delegate to. */
  platform: KernelPlatform
  providers: () => ProviderConnection[]
  /** Loopback origin of this server — exact-endpoint gateway providers route
   * their models.json baseUrl through /api/llm-relay here. */
  relayOrigin: string
  /** Monotonic config-store version (bumped on every providers/settings
   * mutation). */
  configVersion: () => number
  modelResolver: ModelResolver
  queries: AgentQueries
  bus: LiveBus
  getSettings: () => FlatSettings
  /** Time layer: deadline/grace timers, bounded aborts (tests inject a fake
   * clock). */
  clock: Clock
  /** Monotonic ISO stamp (never repeats) for fact payloads. */
  now: () => string
  /** Test seam: bound on `session.abort()` inside close paths. */
  closeAbortGraceMs: number
  /** Test seam: grace between deadline-abort and a forced dispose. */
  timeoutGraceMs?: number
  agentSettings: () => AgentLoopSettings
  /** Test seam: override the host-session creation (default = createAgentHost). */
  createHost: typeof createAgentHost
  /** Admission critical section: the composition root binds the spawn-fence
   * policy + the global fence lock around the row insert. The kernel knows
   * the hook, never the fence. */
  admission: SpawnAdmission
  /** Role-based extra host tools for ORCHESTRATOR sessions (the composition
   * root binds the L3 submit_plan tool; the kernel knows only "the
   * orchestrator's extras", never their content). Called at every session
   * build (spawn AND reopen), keyed by the agent's own row — never derived
   * from the tools snapshot. */
  orchestratorTools(row: { id: string; eventId: string }): ToolDefinition[]
  /** Unattended appliance mode (`AEGISX_UNATTENDED=1`) — boot recovery must
   * not force event queues into `paused`. */
  unattended: boolean
}

export type AgentKernel = ReturnType<typeof createAgentKernel>

/**
 * The L2 agent kernel: per-agent runtimes registry, spawn assembly, turn
 * driving, settle semantics, the per-agent chain locks and the status
 * facts/live-bus half. Its ONLY exits are this verb surface (consumed by L3
 * through this index) and {@link AgentKernel.registerLifecycle} — the
 * composition-root-registered outbound callbacks through which every L3
 * reaction (notices, queue release, engine feeds) enters. The kernel does
 * not know queue, fence, engine, channels or notices.
 */
export function createAgentKernel(deps: AgentKernelDeps) {
  const { db, containerManager, modelResolver, queries, bus, clock, now } = deps

  /** Live agents' in-process resources: one runtime per touched agent (the
   * mounted session, deadline/grace timers, finish_run bookkeeping, turn
   * generation). The ONLY per-agent registry — settle() is the single
   * path that empties an entry. Cold-restored idle/terminal agents have no
   * entry (the DB row is their state; a message rebuilds the runtime). */
  const runtimes = new Map<string, AgentRuntime>()
  /** Per-agent promise-chaining locks (the only concurrency mechanism). */
  const locks = new Map<string, Promise<unknown>>()
  let closed = false
  /** The composition-registered L3 reactor — the single L2→L3 channel. */
  let reactor: LifecycleReactor | undefined
  const lifecycle = (): LifecycleReactor => {
    if (!reactor) {
      throw new Error("kernel lifecycle reactor registered too late")
    }
    return reactor
  }

  const status: AgentStatus = createAgentStatus({
    db,
    queries,
    bus,
    now,
    lifecycle,
  })

  function withLock<T>(agentId: string, op: () => T | Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new RunActionError("invalid_state", "Agent service is closed")
      )
    }
    return chainLock(locks, agentId, op)
  }

  /** Raw chain lock on the shared map — for critical sections that must run
   * even while the kernel is closing (the scheduler start lock, whose
   * existing/again checks re-run inside). */
  function chain<T>(key: string, op: () => T | Promise<T>): Promise<T> {
    return chainLock(locks, key, op)
  }

  /** The runtime deps are per-agent-invariant: every runtime shares them,
   * only the agentId differs (passed to createAgentRuntime). */
  const runtimeDeps: AgentRuntimeDeps = {
    db,
    status,
    clock,
    closeAbortGraceMs: deps.closeAbortGraceMs,
    ...(deps.timeoutGraceMs !== undefined
      ? { timeoutGraceMs: deps.timeoutGraceMs }
      : {}),
    withLock,
    now,
    forget: (agentId) => runtimes.delete(agentId),
    destroySandbox,
    // Forward reference: the factory is assembled below; the cold-resume
    // hop only fires long after construction returns.
    resumeAgent: (agentId) => factory.resumeAgent(agentId),
  }

  /** Get-or-create the agent's runtime — created on first touch (session
   * mount, deadline arm, finish bookkeeping, send), removed ONLY by settle
   * or kernel close. */
  function runtimeOf(agentId: string): AgentRuntime {
    let runtime = runtimes.get(agentId)
    if (!runtime) {
      runtime = createAgentRuntime(agentId, runtimeDeps)
      runtimes.set(agentId, runtime)
    }
    return runtime
  }

  function requireAgent(agentId: string): AgentSummary {
    const agent = queries.getAgent(agentId)
    if (!agent) throw new RunActionError("not_found", "Agent not found")
    return agent
  }

  /** Destroy one agent's sandbox container: ONE `remove(force)` (pid1 is
   * `sleep infinity`, nothing to flush — no grace timer, which could only
   * murder a same-name successor). Fire-and-forget; the name derives from
   * the agent row (the scheduler rides its per-event orchestrator container).
   * Idempotent: missing rows/containers are no-ops. */
  function destroySandbox(agentId: string): void {
    const row = queries.getAgentRow(agentId)
    if (!row) return
    const name = row.challengeId
      ? agentContainerName(agentId)
      : orchestratorContainerName(row.eventId)
    void containerManager.remove(name).catch((error) => {
      console.error("sandbox destroy failed", {
        agentId,
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Deliver a message through the agent's runtime (steer / followUp while
   * streaming, fresh turn otherwise, cold resume when session-less). */
  function sendToAgent(
    agentId: string,
    text: string,
    deliverAs?: "steer" | "followUp",
    opts?: { assertLive?: (id: string) => boolean }
  ): Promise<SendOutcome> {
    return runtimeOf(agentId).send(text, deliverAs, opts)
  }

  /** The ONE terminal-settle path (timeout force-abort, finish_run
   * self-termination, close, finish, delete, superseded launch). Agents with
   * a runtime settle through it (bounded abort → dispose → timers + finish
   * bookkeeping → terminalize incl. the live-bus forget → sandbox destroy →
   * delete-only teardown); agents without one (never prepared — e.g. a spawn
   * that failed before its session mounted) land straight terminal, and the
   * destroy here reclaims a sandbox the failed prepare may have built. */
  async function settleAgent(
    agentId: string,
    opts: SettleOptions
  ): Promise<void> {
    const runtime = runtimes.get(agentId)
    if (runtime) {
      await runtime.settle(opts)
      return
    }
    destroySandbox(agentId)
    status.terminalizeAgent(agentId, {
      status: opts.status,
      summary: opts.summary,
      error: opts.error,
      event: opts.event,
      actor: opts.actor,
      by: opts.by,
    })
    opts.afterSettle?.()
  }

  const factory = createAgentFactory({
    db,
    dataDir: deps.dataDir,
    containerManager,
    platform: deps.platform,
    providers: deps.providers,
    relayOrigin: deps.relayOrigin,
    configVersion: deps.configVersion,
    modelResolver,
    queries,
    bus,
    hasLiveSession: (agentId) => runtimes.get(agentId)?.hasSession() ?? false,
    mountSession: (agentId, session) =>
      runtimeOf(agentId).mountSession(session),
    armDeadline: (agentId, deadlineAt) =>
      runtimeOf(agentId).armDeadline(deadlineAt),
    send: (agentId, text) => sendToAgent(agentId, text),
    requestFinish: (agentId, summary) =>
      runtimeOf(agentId).requestFinish(summary),
    hasFinishFlagWarned: (agentId) =>
      runtimes.get(agentId)?.hasFinishFlagWarned() ?? false,
    markFinishFlagWarned: (agentId) =>
      runtimeOf(agentId).markFinishFlagWarned(),
    admission: deps.admission,
    orchestratorTools: (row) => deps.orchestratorTools(row),
    getSettings: deps.getSettings,
    now,
    status,
    lifecycle,
    settleFailedSpawn: (agentId, error) =>
      settleAgent(agentId, {
        abort: false,
        status: "failed",
        error,
        by: { kind: "system", actorId: "spawn-failure" },
      }),
    agentSettings: deps.agentSettings,
    createHost: deps.createHost,
    unattended: deps.unattended,
  })

  // --- multi-session + flat backtrack (v12) --------------------------------
  const sessionOps = createAgentSessionOps({
    db,
    dataDir: deps.dataDir,
    sessionOf: (agentId) => runtimes.get(agentId)?.session(),
    detachSession: (agentId) => {
      runtimes.get(agentId)?.unmountSession()
    },
    withLock,
    prepareAgent: (agentId) => factory.prepareAgent(agentId),
    resumeAgent: (agentId) => factory.resumeAgent(agentId),
    emitAgent: status.emitAgent,
    requireAgent,
    now,
  })

  // --- lifecycle verbs -------------------------------------------------------

  /** Terminal close (user/scheduler): abort + dispose the session, land
   * aborted. Files and the DB session survive (reopen on demand). Scope
   * assertion is the caller's (composition facade). */
  async function closeAgent(
    agentId: string,
    by: DomainEventActor
  ): Promise<void> {
    const agent = requireAgent(agentId)
    if (isTerminalAgentStatus(agent.status)) {
      throw new RunActionError("invalid_state", "Agent is already closed")
    }
    await withLock(agentId, async () => {
      const current = queries.getAgentRow(agentId)
      if (current && isTerminalAgentStatus(current.status)) {
        throw new RunActionError("invalid_state", "Agent is already closed")
      }
      await settleAgent(agentId, {
        abort: true,
        status: "aborted",
        by,
      })
    })
  }

  /** Force-finish (HTTP /finish): the sanctioned terminal transition with a
   * summary. Idempotent on an already-completed agent. `actor` labels who
   * called it (user vs the event's scheduler) on the finished event. */
  async function finishAgent(
    agentId: string,
    summary: string,
    actor: "user" | "scheduler",
    by: DomainEventActor
  ): Promise<AgentSummary> {
    const agent = requireAgent(agentId)
    if (agent.status === "completed") return agent
    if (isTerminalAgentStatus(agent.status)) {
      throw new RunActionError("invalid_state", "Agent is already closed")
    }
    return withLock(agentId, async () => {
      const current = queries.getAgentRow(agentId)
      if (current?.status === "completed") return requireAgent(agentId)
      if (current && isTerminalAgentStatus(current.status)) {
        throw new RunActionError("invalid_state", "Agent is already closed")
      }
      await settleAgent(agentId, {
        abort: true,
        status: "completed",
        summary,
        event: "agent.finished",
        actor,
        by,
      })
      return requireAgent(agentId)
    })
  }

  /** Plan-path stop (run/plan): pi's abort does not interrupt an in-flight
   * tool call, so the abort wait is BOUNDED — on expiry the agent force-
   * disposes through the standard settle path (the close semantics), never
   * hanging the plan application chain. */
  async function stopBounded(
    agentId: string,
    by: DomainEventActor
  ): Promise<void> {
    const runtime = runtimes.get(agentId)
    if (!runtime) return
    let aborted = false
    await Promise.race([
      runtime
        .abort()
        .catch(() => undefined)
        .then(() => {
          aborted = true
        }),
      clock.sleep(deps.closeAbortGraceMs),
    ])
    if (aborted) return
    const current = runtime.session()
    if (current?.session.isStreaming) {
      await settleAgent(agentId, {
        abort: false,
        status: "aborted",
        by,
      })
    }
  }

  /** Per-agent stop: abort the current turn; it settles to idle (the
   * sandbox stays warm). */
  async function abort(agentId: string): Promise<void> {
    await runtimes
      .get(agentId)
      ?.abort()
      .catch(() => undefined)
  }

  /** Replace an agent's steer/followUp queue. Serialized against its turns;
   * uses the SDK queue API directly. */
  async function setQueue(
    agentId: string,
    input: { steering: string[]; followUp: string[] }
  ): Promise<void> {
    return withLock(agentId, async () => {
      const session = runtimes.get(agentId)?.session()
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
  async function compactAgent(agentId: string): Promise<void> {
    await withLock(agentId, async () => {
      const session = runtimes.get(agentId)?.session()
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
  }

  /** Per-agent model switch: takes effect next turn; persists the snapshot
   * on the agent row. Serialized on the agent's lock against its turns. */
  async function switchModel(
    agentId: string,
    model: string,
    by: DomainEventActor
  ): Promise<AgentSummary> {
    return withLock(agentId, async () => {
      const session = runtimes.get(agentId)?.session()
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
          deps.providers(),
          model,
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
      const to = formatModelRef(
        target.provider,
        target.model,
        result.thinkingLevel
      )
      emitDomainEvent(db, {
        type: "agent.model_switched",
        eventId: agentRow?.eventId ?? null,
        challengeId: agentRow?.challengeId ?? null,
        agentId,
        actor: by,
        payload: {
          from: agentRow?.model ?? null,
          to,
          thinkingLevel: result.thinkingLevel,
          at: now(),
        },
      })
      status.emitAgent(agentId)
      return requireAgent(agentId)
    })
  }

  return {
    // --- verbs
    /** Spawn sequence: render → admission critical section (hook) → row
     * insert → container + host session. Returns the rendered launch
     * artifacts (prime prompt + deadline) for the L3 spawn-service. */
    prepare: factory.prepare,
    send: sendToAgent,
    abort,
    settle: settleAgent,
    stopBounded,
    armDeadline: (agentId: string, deadlineAt: string | null) =>
      runtimeOf(agentId).armDeadline(deadlineAt),
    emitAgent: status.emitAgent,
    // --- read-only
    hasSession: (agentId: string) =>
      runtimes.get(agentId)?.hasSession() ?? false,
    isStreaming: (agentId: string) =>
      Boolean(runtimes.get(agentId)?.session()?.session.isStreaming),
    sessionOf: (agentId: string) => runtimes.get(agentId)?.session(),
    /** The agent's current turn generation (0 when no runtime is live). The
     * submit_plan tool handler stamps its engine registration with the
     * in-flight turn's generation at call time. */
    turnGenerationOf: (agentId: string) =>
      runtimes.get(agentId)?.turnGeneration() ?? 0,
    workspaceKeyOf: factory.workspaceKeyOf,
    // --- workspace runtime
    ensureWorkspaceRuntimeFresh: factory.ensureWorkspaceRuntimeFresh,
    forgetWorkspace: factory.forgetWorkspace,
    // --- multi-session ops
    listSessions: sessionOps.listSessions,
    createSession: sessionOps.createSession,
    activateSession: sessionOps.activateSession,
    backtrack: sessionOps.backtrack,
    // --- close paths
    closeAgent,
    finishAgent,
    setQueue,
    compactAgent,
    switchModel,
    // --- shared locks (agent ids + `start:<eventId>` critical sections)
    withLock,
    chain,
    // --- boot + shutdown
    recoverOnBoot: factory.recoverOnBoot,
    /** Flip the closed gate + drain the locks (the facade orchestrates the
     * full close order around it). */
    close: async (): Promise<void> => {
      closed = true
      await Promise.allSettled(locks.values())
      locks.clear()
    },
    /** Release every runtime's in-process resources (the facade's close
     * calls this after the L3 teardowns, preserving the historical order). */
    disposeRuntimes: async (): Promise<void> => {
      // Each runtime owns its agent's timers (deadline/grace), finish
      // bookkeeping and session: disposing them releases every per-agent
      // resource in one sweep — there is no other registry to clear.
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.dispose()))
      runtimes.clear()
    },
    // --- composition-root registration (the only L2→L3 channel)
    registerLifecycle(next: LifecycleReactor): void {
      reactor = next
    },
  }
}
