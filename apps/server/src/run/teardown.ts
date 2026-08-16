import type { SessionLifecycle } from "../agents/lifecycle"
import type { LiveBus } from "../agents/live"
import { agents, runs } from "../db/schema"
import type { EventScopeEmitter } from "../orchestration/event-scope"
import type { EventScopePayload } from "../orchestration/types"
import type { ContainerManager } from "./container/container-manager"
import type { RunQueries } from "./queries"
import type { QueueService } from "./queue"
import type { RunContext } from "./run-factory"
import type { SchedulerInbox } from "./scheduler-inbox"

/** Grace between SIGTERM and a forced SIGKILL on container teardown. */
const FORCE_KILL_GRACE_MS = 10_000

export type RunTeardownDeps = {
  containerManager: ContainerManager
  queries: RunQueries
  bus: LiveBus
  lifecycle: SessionLifecycle
  /** Reusable per-run handles (entry snapshot lives on the agent row). */
  contexts: Map<string, RunContext>
  /** Scheduler task queue (assigned after construction; read via getter). */
  queue: () => QueueService | undefined
  /** Per-event run-lifecycle emitters, owned by the event's scheduler run. */
  eventScopes: Map<string, EventScopeEmitter>
  /** Per-event scheduler inboxes, same lifetime as their emitter (closed +
   * dropped together). */
  inboxes: Map<string, SchedulerInbox>
  /** Runs finish_run already warned about a missing flag (once per run). */
  finishFlagWarned: Set<string>
  now(): string
  updateRun(runId: string, patch: Partial<typeof runs.$inferInsert>): void
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  containerName(runId: string): string
  /** Deadline timers for the run (cleared on teardown). */
  clearRunTimers(runId: string): void
  emitRun(runId: string): void
  emitAgents(runId: string): void
  emitRunEvent(runId: string, payload: EventScopePayload): void
  /** W4.3: stop the challenge's platform target when this teardown orphans it
   * (no other live run on the same challenge). Fire-and-forget, errors
   * swallowed. Provided by the run service. */
  stopTargetIfOrphaned(runId: string, challengeId: string | null): void
}

export type RunTeardown = ReturnType<typeof createRunTeardown>

/** Container force-kill + sanctioned `closed` teardown. Owns the SIGKILL grace
 * timers (one per run); teardownRun stamps the row closed and releases every
 * live resource (container, agent sessions, bus snapshots) while
 * keeping the DB sessions + agent rows so the run is cold-restorable. */
export function createRunTeardown(deps: RunTeardownDeps) {
  const {
    containerManager,
    queries,
    bus,
    lifecycle,
    contexts,
    queue,
    eventScopes,
    inboxes,
    finishFlagWarned,
    now,
    updateRun,
    updateAgent,
    containerName,
    clearRunTimers,
    emitRun,
    emitAgents,
    emitRunEvent,
    stopTargetIfOrphaned,
  } = deps
  const forceKillTimers = new Map<string, NodeJS.Timeout>()

  function clearForceKill(runId: string) {
    const timer = forceKillTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      forceKillTimers.delete(runId)
    }
  }

  function terminateContainer(runId: string, name: string) {
    clearForceKill(runId)
    void containerManager.kill(name, "SIGTERM").catch(() => undefined)
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
    }, FORCE_KILL_GRACE_MS)
    forceKillTimers.set(runId, timer)
  }

  /** Sanctioned `closed` transition: stamp the row, then release live
   * resources outside the lock. Aborts every still-streaming agent (per-agent
   * locks; in-flight docker exec is dropped by dispose), disposes ALL live
   * agent sessions (not just the entry), and keeps the DB sessions + agent
   * rows so the run is cold-restorable. */
  function teardownRun(
    runId: string,
    opts: { summary?: string; finished?: boolean } = {}
  ) {
    const ts = now()
    const agents = queries.listAgents(runId)
    // Best-effort abort of anything still streaming, so no turn keeps running
    // against a dying run (their settles become no-ops once sessions are gone).
    for (const agent of agents) {
      if (agent.status !== "running") continue
      void lifecycle
        .get(agent.id)
        ?.session.abort()
        .catch(() => undefined)
    }
    const patch: Partial<typeof runs.$inferInsert> = {
      status: "closed",
      updatedAt: ts,
    }
    if (opts.summary !== undefined) patch.summary = opts.summary
    if (opts.finished) patch.completedAt = ts
    updateRun(runId, patch)
    // Any still-running agent lands on `idle` (its live session is gone).
    finishFlagWarned.delete(runId)
    for (const agent of agents) {
      if (agent.status === "running") {
        updateAgent(agent.id, { status: "idle", updatedAt: ts })
      }
    }
    clearRunTimers(runId)
    terminateContainer(runId, containerName(runId))
    // A closed scheduler run stops receiving child-run events; the emitter
    // and its inbox are dropped and rebuilt fresh by the next scheduler start.
    const row = queries.getRow(runId)
    if (row?.scopeType === "event") {
      eventScopes.get(row.eventId)?.close()
      eventScopes.delete(row.eventId)
      inboxes.get(row.eventId)?.close()
      inboxes.delete(row.eventId)
    }
    // Dispose every live agent session, then drop the run-level context.
    for (const agent of agents) {
      const session = lifecycle.get(agent.id)
      if (session) {
        void session.dispose()
        lifecycle.delete(agent.id)
      }
    }
    contexts.delete(runId)
    // Closed run: drop its replay snapshots (channel lastRun + every agent's
    // context/queue/activity/running-tools) so long-lived memory stays flat.
    // A cold-restored run rebuilds them from the first post-resume events.
    bus.forget(
      runId,
      agents.map((agent) => agent.id)
    )
    emitRun(runId)
    emitAgents(runId)
    if (opts.finished) emitRunEvent(runId, { type: "run.finished", runId })
    // W4.3: a sanctioned teardown on the last live run of a target-capable
    // challenge orphans its platform target — stop it (fire-and-forget).
    stopTargetIfOrphaned(runId, row?.challengeId ?? null)
    // A queue-sourced run closing/finishing transitions its item to done
    // (guarded by id + runId); freeing a slot re-drains the queue.
    queue()?.markDone(row?.queueItemId, runId)
    queue()?.scheduleDrain()
  }

  return { clearForceKill, terminateContainer, teardownRun, forceKillTimers }
}
