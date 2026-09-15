import type { Database } from "../../db"
import {
  emitDomainEvent,
  actorLabel,
  type DomainEventActor,
} from "../domain-events/store"
import type { LiveBus } from "../host/live"
import type { AgentQueries } from "../queries"

/** The terminal reaction's payload: what the L3 lifecycle reactor needs to
 * release the queue item and post the finish line. */
export type TerminalInfo = {
  queueItemId: string | null
  /** When set, the reactor posts the finish lifecycle line (agent.finished). */
  event?: "agent.finished"
  /** Who drove the transition (user vs scheduler) — the finish line's label. */
  actor?: "user" | "scheduler"
}

/**
 * The L2→L3 outbound face. The kernel emits facts + live-bus events itself;
 * everything beyond that (template lifecycle notices with their urgent and
 * scheduler-paused gates, queue release + re-drain, the decision-engine
 * trigger feeds, aborted-workspace recycling, target-stop policy) is L3
 * policy and enters ONLY through these composition-root-registered
 * callbacks. Callback order is kernel contract — the reactor must preserve
 * today's sequencing (see each member).
 */
export type LifecycleReactor = {
  /** Turn settled: the idle lifecycle line, then the engine's settled feed
   * (notice first, feed second). */
  onTurnSettled(agentId: string, error: string | null): void
  /** A deadline fire's timedOut line + the urgent engine trigger (solver
   * agents only). */
  onAgentTimedOut(agentId: string, outcome: "aborted" | "idle"): void
  /** A terminal agent was reopened (the reopened lifecycle line). */
  onAgentReopened(agentId: string): void
  /** Terminal landing: queue release (markDone) → re-drain → the engine's
   * terminal feed + workspace recycling + target-stop policy → the finish
   * line. Exacts `terminalizeAgent`'s historical tail order. */
  onTerminal(agentId: string, info: TerminalInfo): void
  /** Boot recovery found a live agent with a queue item: reset the event's
   * running items. */
  onBootQueueReset(eventId: string): void
  /** Boot recovery (unattended) has visible pending items: schedule a drain. */
  onBootDrain(): void
}

export type AgentStatusDeps = {
  db: Database
  queries: AgentQueries
  bus: LiveBus
  now: () => string
  /** The composition-registered reactor; every call happens long after
   * assembly, so an unregistered read fails loudly instead of silently
   * dropping a lifecycle reaction. */
  lifecycle(): LifecycleReactor
}

export type AgentStatus = ReturnType<typeof createAgentStatus>

/**
 * The kernel half of agent status (v19: per-agent). Turn start/settle and
 * the terminal landing are agent.* domain facts — the agents row follows
 * from their projections — plus the live-bus emits. Everything else that
 * used to live here (template lifecycle notices, queue release, engine
 * feeds) is L3 reaction policy and goes through {@link LifecycleReactor}.
 */
export function createAgentStatus(deps: AgentStatusDeps) {
  const { db, queries, bus, now } = deps

  function emitAgent(agentId: string) {
    const agent = queries.getAgent(agentId)
    if (agent) bus.emit(agentId, { type: "agent.updated", agent })
  }

  /** Mark an agent's turn starting: the agent.turn_started fact (its
   * projection lands status running + error cleared). */
  function agentTurnStart(agentId: string, sessionId?: string): void {
    const row = queries.getAgentRow(agentId)
    if (!row) return
    emitDomainEvent(db, {
      type: "agent.turn_started",
      eventId: row.eventId,
      challengeId: row.challengeId,
      agentId,
      actor: { kind: "agent", agentId },
      payload: {
        ...(sessionId !== undefined ? { sessionId } : {}),
        at: now(),
      },
    })
    emitAgent(agentId)
  }

  /** Mark an agent's turn settled. `error` (already logged by the runtime)
   * settles the fact `failed`; a clean settle lands idle. The idle line and
   * the engine's settled feed are reactor policy, in that order. */
  function agentTurnSettled(agentId: string, error: string | null): void {
    const ts = now()
    const row = queries.getAgentRow(agentId)
    if (row) {
      emitDomainEvent(db, {
        type: "agent.turn_settled",
        eventId: row.eventId,
        challengeId: row.challengeId,
        agentId,
        actor: { kind: "agent", agentId },
        payload: {
          outcome: error ? "failed" : "idle",
          ...(error ? { error } : {}),
          at: ts,
        },
      })
    }
    emitAgent(agentId)
    deps.lifecycle().onTurnSettled(agentId, error)
  }

  /** A deadline fire resolved: the timedOut line + urgent engine trigger
   * (reactor policy — the kernel half is only the hop). */
  function agentTimedOut(agentId: string, outcome: "aborted" | "idle"): void {
    deps.lifecycle().onAgentTimedOut(agentId, outcome)
  }

  /** Terminal transition shared by finish_run (settle path), the HTTP
   * finish, close, the timeout force-abort, and the spawn-failure landing:
   * the agent.terminated fact (its projection stamps the row), then the bus
   * emit + the live-bus snapshot forget, and finally the reactor's terminal
   * release (queue markDone → re-drain → engine feed/recycling/target-stop →
   * the finish line). The caller handles session disposal/abort before
   * this. */
  function terminalizeAgent(
    agentId: string,
    opts: {
      status: "completed" | "aborted" | "failed"
      summary?: string
      /** Spawn-failure landing's launch error (completedAt stays null). */
      error?: string
      event?: "agent.finished"
      /** Who drove the transition (user vs scheduler) — the finish event's
       * origin label. */
      actor?: "user" | "scheduler"
      /** The fact's producer (user / agent / system subsystem). */
      by?: DomainEventActor
    }
  ): void {
    const ts = now()
    const row = queries.getAgentRow(agentId)
    const by = opts.by ?? { kind: "system" as const, actorId: "run" }
    if (row) {
      emitDomainEvent(db, {
        type: "agent.terminated",
        eventId: row.eventId,
        challengeId: row.challengeId,
        agentId,
        actor: by,
        payload: {
          status: opts.status,
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
          ...(opts.error !== undefined ? { error: opts.error } : {}),
          at: ts,
          actor: actorLabel(by),
        },
      })
    }
    emitAgent(agentId)
    bus.forget([agentId])
    deps.lifecycle().onTerminal(agentId, {
      queueItemId: row?.queueItemId ?? null,
      ...(opts.event !== undefined ? { event: opts.event } : {}),
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    })
  }

  return {
    emitAgent,
    agentTurnStart,
    agentTurnSettled,
    agentTimedOut,
    terminalizeAgent,
  }
}
