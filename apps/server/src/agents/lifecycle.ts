import type { HostAgentSession } from "./host-session"

/**
 * Concurrency-safe turn-driving for a host-side agent session, shared by the
 * run service (solver main agent) and the orchestrator service. Both own N
 * independent sessions keyed by id (run id / event id); this core factors out
 * the mechanics that are identical between them:
 *
 *  - per-id lock serialization (the caller's own `withLock`, so service-native
 *    action-error types survive),
 *  - a monotonic per-id turn generation so a stale turn's settle is a no-op
 *    when a newer turn has started (this is the guard the orchestrator was
 *    missing — it let two notifications double-drive one session),
 *  - drive → prompt → settle, with settle re-checking the generation and that
 *    the session wasn't replaced/closed mid-turn,
 *  - send (steer / followUp while streaming, else a fresh turn) and abort.
 *
 * Everything that genuinely differs — status persistence, containers, child
 * agents, timers, notify triggers — stays in the owning service and is reached
 * through the hooks below.
 */
export type SessionLifecycleOptions = {
  /** Logged label for the entity kind ("run" / "orchestrator"). */
  kind: string
  /** The owning service's per-id lock. Reused (not duplicated) so bespoke
   * service ops (create / close / finish / ...) serialize against turns. */
  withLock<T>(id: string, op: () => T | Promise<T>): Promise<T>
  /** A turn is starting (status → running). Run: mark run + main agent running
   * and emit. Orchestrator: mark running. */
  onTurnStart?(id: string): void
  /** The freshest turn settled. Run: consume pending finish/close or go idle.
   * Orchestrator: go idle. `error` is the prompt error, if any (already logged
   * by the core). */
  onTurnSettled(id: string, error: string | null): void
  /** Called just before driving a fresh turn from send() (run: clear pending). */
  onBeforeNewTurn?(id: string): void
  /** Fresh-turn gate: awaited in send()'s non-streaming branch, BEFORE
   * onBeforeNewTurn, inside the caller's lock. Throw = the turn is abandoned
   * and send() propagates the error to its caller. steer/followUp (streaming
   * branch) and drive() callers (deliverToParent, system prime) do NOT pass
   * through this hook — internal dispatch must never be capacity-rejected. */
  onTurnGate?(id: string): Promise<void>
  /** Cold-resume a closed entity so send() can start a new turn (run:
   * ensureWarm). Omit to reject sends to entities without a live session
   * (orchestrator: sends require a running session). */
  onResume?(id: string): Promise<void>
}

export type SessionLifecycle = {
  /** Live session map (main agent per run / the single orchestrator session). */
  get(id: string): HostAgentSession | undefined
  has(id: string): boolean
  set(id: string, session: HostAgentSession): void
  delete(id: string): void
  /** Drive one prompt turn to completion, then settle. No-op without a live
   * session. Called within the caller's lock (create / send); settle re-acquires
   * it. Generation-guarded: a turn whose generation is superseded settles no-op. */
  drive(id: string, text: string): void
  /** Deliver a message: steer / followUp while streaming, else a fresh turn.
   * Rejects if there is no live session and no `onResume` can produce one. */
  send(
    id: string,
    text: string,
    deliverAs?: "steer" | "followUp"
  ): Promise<void>
  /** Abort the current turn (like Esc). It settles to idle via onTurnSettled. */
  abort(id: string): Promise<void>
  /** Drain locks, dispose every live session. Called from the service's close(). */
  closeAll(): Promise<void>
}

export function createSessionLifecycle(
  options: SessionLifecycleOptions
): SessionLifecycle {
  const { kind } = options
  const sessions = new Map<string, HostAgentSession>()
  /** Monotonic per-id turn counter; a stale turn's settle is a no-op. */
  const turnGeneration = new Map<string, number>()

  function drive(id: string, text: string): void {
    const session = sessions.get(id)
    if (!session) return
    const gen = (turnGeneration.get(id) ?? 0) + 1
    turnGeneration.set(id, gen)
    options.onTurnStart?.(id)
    void (async () => {
      let error: string | null = null
      try {
        await session.session.prompt(text)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        console.error(`${kind} prompt failed`, { id, error })
      }
      settle(id, session, error, gen)
    })()
  }

  /** Turn resolved — the single settle point. Under the lock: bail if a newer
   * turn started (generation) or the session was replaced/closed, else hand off
   * to the service's settle hook. */
  function settle(
    id: string,
    driven: HostAgentSession,
    error: string | null,
    gen: number
  ): void {
    void options.withLock(id, () => {
      if (turnGeneration.get(id) !== gen) return
      if (sessions.get(id) !== driven) return
      options.onTurnSettled(id, error)
    })
  }

  async function send(
    id: string,
    text: string,
    deliverAs?: "steer" | "followUp"
  ): Promise<void> {
    await options.withLock(id, async () => {
      let session = sessions.get(id)
      if (!session) {
        if (!options.onResume) return
        await options.onResume(id)
        session = sessions.get(id)
        if (!session) return
      }
      if (session.session.isStreaming) {
        if (deliverAs === "followUp") await session.session.followUp(text)
        else await session.session.steer(text)
        return
      }
      await options.onTurnGate?.(id)
      options.onBeforeNewTurn?.(id)
      drive(id, text)
    })
  }

  async function abort(id: string): Promise<void> {
    await options.withLock(id, async () => {
      const session = sessions.get(id)
      if (session) await session.session.abort().catch(() => undefined)
    })
  }

  async function closeAll(): Promise<void> {
    // Dispose every live session (main agents / orchestrator). Child sessions
    // are owned by the run service and cleared there. The caller drains its
    // own lock map + sets its closed flag first (it owns both).
    for (const session of sessions.values()) await session.dispose()
    sessions.clear()
    turnGeneration.clear()
  }

  return {
    get: (id) => sessions.get(id),
    has: (id) => sessions.has(id),
    set: (id, session) => sessions.set(id, session),
    delete: (id) => sessions.delete(id),
    drive,
    send,
    abort,
    closeAll,
  }
}

/** Per-key promise-chaining lock: serialize async ops under the same key. Each
 * op waits for the previous one (success or failure) before running, and the
 * map entry is cleared once the chain drains. Shared by the run + orchestrator
 * services' `withLock`, which add their own closed-check and bespoke action
 * error type on top. */
export function chainLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  op: () => T | Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(op)
  locks.set(key, next)
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key)
  })
}
