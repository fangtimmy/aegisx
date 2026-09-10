import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { agents } from "../db/schema"
import type { AgentStatus } from "./agent-status"
import { orchKey, type ChannelService } from "./channels"
import type { Clock, ClockTimer } from "./clock"
import { createTimerHub } from "./clock"
import { RunActionError } from "./errors"
import type { HostAgentSession } from "./host/host-session"

/** Grace between deadline-abort and a forced session dispose. */
const TIMEOUT_GRACE_MS = 30_000

/** agent 停滞判定：turn settle 后超过该时长仍 idle/failed → urgent orch
 * 消息（§五）。 */
export const AGENT_STALL_MS = 2 * 60_000

/** 时间格式化（watchdog 行与 SDK `fmt_ms` 共用格式约定）：
 *  3500 → "4s"；210000 → "3m30s"；-45000 → "-45s(超时)"。 */
export function fmtMs(ms: number): string {
  if (ms < 0) return `-${fmtMs(-ms)}(超时)`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem === 0 ? `${h}h` : `${h}h${rem}m`
  }
  return s === 0 ? `${m}m` : `${m}m${s}s`
}

/** The one terminal transition (timeout force-abort, finish_run
 * self-termination, close, finish, delete, superseded launch). */
export type SettleOptions = {
  /** Bounded-abort the streaming turn first. Only user-driven closes abort —
   * the timeout and self-termination paths have a turn that is already dead. */
  abort: boolean
  status: "completed" | "aborted" | "failed"
  summary?: string
  event?: "agent.finished"
  /** Who drove the transition (user vs scheduler) — the finish event's
   * origin label. */
  actor?: "user" | "scheduler"
  /** Delete-only teardown, run after the terminal status has landed. */
  afterSettle?: () => void
}

export type AgentRuntimeDeps = {
  db: Database
  channels: ChannelService
  /** Status core: turn markers, the terminal landing, the orch event feed. */
  status: AgentStatus
  /** Time layer: arms the deadline/grace/stall timers, bounds aborts, reads
   * the stall age. */
  clock: Clock
  /** Test seam passthrough: bound on `session.abort()` inside close paths. */
  closeAbortGraceMs: number
  /** Test seam passthrough: grace between deadline-abort and a forced
   * dispose. */
  timeoutGraceMs?: number
  /** Test seam passthrough: stall watchdog threshold. */
  stallMs?: number
  /** W3: the event's scheduler is paused → stall checks do not arm. */
  isSchedulerPaused(eventId: string): boolean
  /** The service's per-agent lock — turns serialize against bespoke ops
   * (create / close / finish / ...) and a service close rejects them. */
  withLock<T>(agentId: string, op: () => T | Promise<T>): Promise<T>
  updateAgent(agentId: string, patch: Partial<typeof agents.$inferInsert>): void
  now(): string
  /** Current DB status of the agent (null when gone). */
  getAgentStatus(agentId: string): (typeof agents.$inferSelect)["status"] | null
  /** Drop the runtime from the service's registry (settle). */
  forget(agentId: string): void
  /** Cold-resume a session-less agent so send() can start a new turn. */
  resumeAgent(agentId: string): Promise<void>
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>

/**
 * One live agent's ENTIRE in-process ownership root: the mounted host
 * session, the monotonic turn generation, the finish_run bookkeeping, the
 * deadline/grace timers, the stall-watchdog timer, and the single terminal
 * path. Nothing per-agent lives anywhere else — the run service holds
 * `Map<agentId, AgentRuntime>` and every terminal flow converges on
 * {@link AgentRuntime.settle}, so "forgetting to clear one registry" is
 * structurally impossible.
 *
 * Turn driving (send → drive → generation-checked settle) previously lived in
 * the shared session lifecycle; it now runs against this runtime's own
 * session, with the same lock, hook and stale-turn semantics.
 */
export function createAgentRuntime(agentId: string, deps: AgentRuntimeDeps) {
  const { clock } = deps
  const hub = createTimerHub(clock)
  const stallMs = deps.stallMs ?? AGENT_STALL_MS
  const timeoutGraceMs = deps.timeoutGraceMs ?? TIMEOUT_GRACE_MS

  /** The mounted host session (absent until prepare / after unmount). */
  let session: HostAgentSession | undefined
  /** Monotonic turn counter; a stale turn's settle is a no-op. */
  let turnGen = 0
  /** finish_run winner summary, consumed at the turn settle. */
  let pendingFinish: string | undefined
  /** finish_run already warned about a missing flag (once). */
  let finishFlagWarned = false
  let deadlineTimer: ClockTimer | undefined
  let graceTimer: ClockTimer | undefined
  let stallTimer: ClockTimer | undefined

  // --- session mount ---------------------------------------------------------

  function mountSession(next: HostAgentSession): void {
    session = next
  }

  function unmountSession(): HostAgentSession | undefined {
    const current = session
    session = undefined
    return current
  }

  // --- turn driving ------------------------------------------------------------

  function drive(driven: HostAgentSession, text: string): void {
    turnGen += 1
    const gen = turnGen
    deps.status.agentTurnStart(agentId)
    void (async () => {
      let error: string | null = null
      try {
        await driven.session.prompt(text)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        console.error("agent prompt failed", { id: agentId, error })
      }
      settleTurn(driven, error, gen)
    })()
  }

  /** Turn resolved — the single settle point. Under the lock: bail if a newer
   * turn started (generation) or the session was replaced/closed, else
   * consume a pending finish_run (graceful self-termination) or land idle. */
  function settleTurn(
    driven: HostAgentSession,
    error: string | null,
    gen: number
  ): void {
    void deps
      .withLock(agentId, () => {
        if (turnGen !== gen) return
        if (session !== driven) return
        if (pendingFinish !== undefined) {
          void settle({
            abort: false,
            status: "completed",
            summary: pendingFinish,
            event: "agent.finished",
          })
          return
        }
        deps.status.agentTurnSettled(agentId, error)
        noteTurnSettled()
      })
      .catch((err) => {
        // A service close mid-turn rejects the lock with invalid_state — a
        // settling turn racing shutdown is expected, not an error.
        if (err instanceof RunActionError && err.code === "invalid_state")
          return
        console.error("agent settle failed", {
          id: agentId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  /** Deliver a message: steer / followUp while streaming, else a fresh turn.
   * Resolves false WITHOUT delivering when `opts.assertLive` rejects the id
   * inside the lock before any resume (the delivery path re-checked liveness
   * outside the lock and may have lost a race to a concurrent close), or when
   * a resume could not produce a session. */
  async function send(
    text: string,
    deliverAs?: "steer" | "followUp",
    opts?: { assertLive?: (id: string) => boolean }
  ): Promise<boolean> {
    return deps.withLock(agentId, async (): Promise<boolean> => {
      if (opts?.assertLive && !opts.assertLive(agentId)) return false
      let current = session
      if (!current) {
        await deps.resumeAgent(agentId)
        current = session
        if (!current) return false
      }
      if (current.session.isStreaming) {
        if (deliverAs === "followUp") {
          await current.session.followUp(text)
          return true
        }
        // pi queues every steer() as its OWN message, so a second delivery
        // during the same turn would reach the agent as a separate injection
        // — N posts become N messages to reconcile mid-task. Fold it into
        // whatever is already pending instead, so a turn sees one steer.
        const pending = current.session.getSteeringMessages()
        if (pending.length === 0) {
          await current.session.steer(text)
          return true
        }
        // clearQueue drops follow-ups too: restore them after re-queuing the
        // merged steer (their relative order is preserved).
        const { followUp } = current.session.clearQueue()
        await current.session.steer([...pending, text].join("\n\n"))
        for (const queued of followUp) await current.session.followUp(queued)
        return true
      }
      pendingFinish = undefined
      drive(current, text)
      return true
    })
  }

  /** Abort the current turn (like Esc). It settles to idle. */
  async function abort(): Promise<void> {
    await deps.withLock(agentId, async () => {
      if (session) await session.session.abort().catch(() => undefined)
    })
  }

  // --- finish_run bookkeeping ------------------------------------------------

  function requestFinish(summary: string): void {
    pendingFinish = summary
  }

  function hasFinishFlagWarned(): boolean {
    return finishFlagWarned
  }

  function markFinishFlagWarned(): void {
    finishFlagWarned = true
  }

  // --- hard-deadline timers ----------------------------------------------------
  // The deadline belongs to the agent, never to the shared container. At
  // expiry the turn is aborted; a clean settle within the grace lands idle
  // (warm), else the session is force-disposed and the agent goes aborted
  // (the shared container is NEVER killed). The deadline is ONE-SHOT: the
  // fire consumes it (deadlineAt → null), so later turns are unbounded and a
  // reopen never re-arms a stale deadline.

  /** Arm the hard-deadline timer. Idempotent. A deadline already in the past
   * (crash/boot leftovers) is never armed — it would fire at delay 0 and
   * insta-abort the fresh turn the reopen just started. */
  function armDeadline(deadlineAt: string | null): void {
    clearDeadline()
    if (!deadlineAt) return
    const delay = new Date(deadlineAt).getTime() - clock.now()
    if (delay <= 0) return
    deadlineTimer = hub.setTimeout(() => {
      // One-shot: consume the deadline so warm reuse / reopen stays unbounded
      // instead of silently re-arming a stale one.
      deps.updateAgent(agentId, { lastTimeoutAt: deps.now(), deadlineAt: null })
      // Only a live turn can time out. An agent that already settled idle or
      // was closed since the timer was armed just loses its stale deadline —
      // aborting it (or reporting agent.timedOut to the scheduler) would be
      // misleading.
      const live =
        deps.getAgentStatus(agentId) === "running" ||
        Boolean(session?.session.isStreaming)
      if (!live) return
      void abort().catch(() => undefined)
      graceTimer = hub.setTimeout(() => {
        // Still streaming after grace → force-dispose the session →
        // aborted. A clean settle already landed idle.
        const stillStreaming = Boolean(session?.session.isStreaming)
        if (stillStreaming) {
          void settle({ abort: false, status: "aborted" })
        }
        deps.status.emitAgentEvent(agentId, {
          type: "agent.timedOut",
          agentId,
          outcome: stillStreaming ? "aborted" : "idle",
        })
      }, timeoutGraceMs)
    }, delay)
  }

  function clearDeadline(): void {
    if (deadlineTimer) {
      hub.clear(deadlineTimer)
      deadlineTimer = undefined
    }
    if (graceTimer) {
      hub.clear(graceTimer)
      graceTimer = undefined
    }
  }

  // --- stall watchdog ----------------------------------------------------------

  /** Arm the stall check for a turn that just settled idle/failed. The fire
   * time re-checks the DB, so a mid-timer resume/finish is judged from
   * current state (race-safe). Solver agents only; paused events skip.
   * Each idle cycle fires at most once (a fresh settle re-arms). */
  function noteTurnSettled(): void {
    const row = deps.db
      .select({
        role: agents.role,
        eventId: agents.eventId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!row || row.role !== "solver") return
    if (deps.isSchedulerPaused(row.eventId)) return
    clearStallTimer()
    stallTimer = hub.setTimeout(() => {
      stallTimer = undefined
      checkStall()
    }, stallMs)
  }

  function clearStallTimer(): void {
    if (stallTimer) {
      hub.clear(stallTimer)
      stallTimer = undefined
    }
  }

  /** Stall timer fired: re-check the agent — an idle/failed agent still idle
   * ≥ stallMs posts the urgent orch message (the scheduler reads it on
   * catch-up when offline); otherwise silent. A terminal agent never fires a
   * false alarm. */
  function checkStall(): void {
    const row = deps.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!row || row.role !== "solver") return
    if (row.status !== "idle" && row.status !== "failed") {
      return
    }
    if (deps.isSchedulerPaused(row.eventId)) return
    const nowMs = clock.now()
    if (nowMs - Date.parse(row.updatedAt) < stallMs) return
    deps.channels.post(
      {
        channelKey: orchKey(row.eventId),
        author: { type: "system" },
        body: `停滞：agent-${agentId.slice(0, 8)} 已闲置 ${fmtMs(nowMs - Date.parse(row.updatedAt))}`,
        meta: { agentId, noticeType: "emergency" },
        urgent: true,
      },
      { kind: "system" }
    )
  }

  // --- the one terminal path ---------------------------------------------------

  /** Land the terminal state and release every in-process resource: bounded
   * abort (when the caller is a user-driven close) → dispose the session →
   * drop the timers + finish bookkeeping → leave the registry → terminalize
   * (the status core forgets the agent's bus snapshots) → delete-only
   * teardown. */
  async function settle(opts: SettleOptions): Promise<void> {
    const current = session
    if (opts.abort) await abortBounded(current)
    if (current) {
      void current.dispose()
      session = undefined
    }
    hub.disposeAll()
    deadlineTimer = undefined
    graceTimer = undefined
    stallTimer = undefined
    pendingFinish = undefined
    finishFlagWarned = false
    deps.forget(agentId)
    deps.status.terminalizeAgent(agentId, {
      status: opts.status,
      summary: opts.summary,
      event: opts.event,
      actor: opts.actor,
    })
    opts.afterSettle?.()
  }

  /** Close paths must never hang on `session.abort()`: pi's abort does not
   * interrupt an in-flight tool call, so a streaming turn can outlive the
   * awaiter indefinitely — the deadline path carries the same
   * abort-then-force-dispose fallback for exactly this reason. Bound the
   * wait; the caller disposes regardless, which is the sanctioned force
   * stop. */
  async function abortBounded(
    current: HostAgentSession | undefined
  ): Promise<void> {
    if (!current?.session.isStreaming) return
    await Promise.race([
      current.session.abort().catch(() => undefined),
      clock.sleep(deps.closeAbortGraceMs),
    ])
  }

  /** Release the in-process resources WITHOUT landing a DB state (terminal
   * statuses go through settle; service close calls this per runtime). */
  async function dispose(): Promise<void> {
    hub.disposeAll()
    deadlineTimer = undefined
    graceTimer = undefined
    stallTimer = undefined
    pendingFinish = undefined
    finishFlagWarned = false
    turnGen = 0
    const current = unmountSession()
    if (current) await current.dispose()
  }

  return {
    agentId,
    session: () => session,
    hasSession: () => session !== undefined,
    mountSession,
    unmountSession,
    send,
    abort,
    requestFinish,
    hasFinishFlagWarned,
    markFinishFlagWarned,
    armDeadline,
    noteTurnSettled,
    settle,
    dispose,
  }
}
