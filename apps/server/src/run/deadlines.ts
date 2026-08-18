import type { SessionLifecycle } from "../agents/lifecycle"
import { agents } from "../db/schema"
import type { EventScopePayload } from "../orchestration/types"

/** Grace between deadline-abort and a forced session dispose. */
const TIMEOUT_GRACE_MS = 30_000

export type AgentDeadlinesDeps = {
  lifecycle: SessionLifecycle
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  now(): string
  /** Still streaming after grace → force terminal (aborted). */
  forceTerminal(agentId: string): void
  emitAgentEvent(agentId: string, payload: EventScopePayload): void
  /** Test seam: grace between deadline-abort and a forced dispose. */
  timeoutGraceMs?: number
}

export type AgentDeadlines = ReturnType<typeof createAgentDeadlines>

/** Per-agent hard-deadline timers (v19: the deadline belongs to the agent,
 * never to the shared container). At expiry the agent's turn is aborted; a
 * clean settle within the grace lands idle (warm), else the session is
 * force-disposed and the agent goes aborted. The outcome is reported to the
 * event's scheduler (`agent.timedOut`). */
export function createAgentDeadlines(deps: AgentDeadlinesDeps) {
  const { lifecycle, updateAgent, now, emitAgentEvent } = deps
  const timeoutTimers = new Map<
    string,
    { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout }
  >()

  function clearAgentTimers(agentId: string): void {
    const t = timeoutTimers.get(agentId)
    if (t?.deadline) clearTimeout(t.deadline)
    if (t?.grace) clearTimeout(t.grace)
    timeoutTimers.delete(agentId)
  }

  function isStreaming(agentId: string): boolean {
    return Boolean(lifecycle.get(agentId)?.session.isStreaming)
  }

  /** Arm an agent's hard-deadline timer. Idempotent. */
  function armAgentTimers(agentId: string, deadlineAt: string | null): void {
    clearAgentTimers(agentId)
    if (!deadlineAt) return
    const delay = Math.max(new Date(deadlineAt).getTime() - Date.now(), 0)
    const entry: { deadline?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {}
    entry.deadline = setTimeout(() => {
      updateAgent(agentId, { lastTimeoutAt: now() })
      void lifecycle.abort(agentId).catch(() => undefined)
      entry.grace = setTimeout(() => {
        // Still streaming after grace → force-dispose the session →
        // aborted. A clean settle already landed idle.
        const stillStreaming = isStreaming(agentId)
        if (stillStreaming) deps.forceTerminal(agentId)
        emitAgentEvent(agentId, {
          type: "agent.timedOut",
          agentId,
          outcome: stillStreaming ? "aborted" : "idle",
        })
      }, deps.timeoutGraceMs ?? TIMEOUT_GRACE_MS)
    }, delay)
    timeoutTimers.set(agentId, entry)
  }

  return { clearAgentTimers, armAgentTimers, timeoutTimers }
}
