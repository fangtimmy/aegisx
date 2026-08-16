import type { SessionLifecycle } from "../agents/lifecycle"
import { runs } from "../db/schema"
import type { EventScopePayload } from "../orchestration/types"
import type { RunQueries } from "./queries"

/** Grace between deadline-abort and a forced SIGKILL (deadline → abort →
 * grace → idle|closed). */
const TIMEOUT_GRACE_MS = 30_000

export type RunDeadlinesDeps = {
  queries: RunQueries
  lifecycle: SessionLifecycle
  updateRun(runId: string, patch: Partial<typeof runs.$inferInsert>): void
  now(): string
  /** Sanctioned closed transition (still-streaming after grace). */
  teardownRun(runId: string): void
  emitRunEvent(runId: string, payload: EventScopePayload): void
  /** Test seam: grace between deadline-abort and a forced SIGKILL. */
  timeoutGraceMs?: number
}

export type RunDeadlines = ReturnType<typeof createRunDeadlines>

/** Per-run hard-deadline timers. At expiry every streaming agent is aborted;
 * if all settle within the grace the run stays `idle` (warm), else the
 * container is SIGKILLed and the run goes `closed`. The outcome is reported to
 * the event's scheduler (`run.timedOut`). */
export function createRunDeadlines(deps: RunDeadlinesDeps) {
  const { queries, lifecycle, updateRun, now, emitRunEvent } = deps
  const timeoutTimers = new Map<
    string,
    { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout }
  >()

  function clearRunTimers(runId: string): void {
    const t = timeoutTimers.get(runId)
    if (t?.deadline) clearTimeout(t.deadline)
    if (t?.grace) clearTimeout(t.grace)
    timeoutTimers.delete(runId)
  }

  /** Every agent with an in-flight turn. */
  function streamingAgentIds(runId: string): string[] {
    const ids: string[] = []
    for (const agent of queries.listAgents(runId)) {
      if (lifecycle.get(agent.id)?.session.isStreaming) ids.push(agent.id)
    }
    return ids
  }

  /** Arm a run's hard-deadline timer. At expiry every streaming agent is
   * aborted; if all settle within the grace the run stays `idle` (warm), else
   * the container is SIGKILLed and the run goes `closed`. The outcome is
   * reported to the event's scheduler (`run.timedOut`). Idempotent. */
  function armRunTimers(runId: string, deadlineAt: string | null): void {
    clearRunTimers(runId)
    if (!deadlineAt) return
    const delay = Math.max(new Date(deadlineAt).getTime() - Date.now(), 0)
    const entry: { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {}
    entry.deadline = setTimeout(() => {
      for (const agentId of streamingAgentIds(runId)) {
        void lifecycle.abort(agentId).catch(() => undefined)
      }
      updateRun(runId, { lastTimeoutAt: now() })
      entry.grace = setTimeout(() => {
        // Still streaming after grace → SIGKILL the container → closed.
        const stillStreaming = streamingAgentIds(runId).length > 0
        if (stillStreaming) deps.teardownRun(runId)
        emitRunEvent(runId, {
          type: "run.timedOut",
          runId,
          outcome: stillStreaming ? "closed" : "idle",
        })
      }, deps.timeoutGraceMs ?? TIMEOUT_GRACE_MS)
    }, delay)
    timeoutTimers.set(runId, entry)
  }

  return { clearRunTimers, streamingAgentIds, armRunTimers, timeoutTimers }
}
