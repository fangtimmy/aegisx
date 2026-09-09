import { RunActionError } from "../run/errors"
import type { HostAgentSession } from "./host-session"

/**
 * Concurrency-safe turn-driving for host-side agent sessions. The run service
 * owns one lifecycle whose id-keyed map holds every live agent session
 * (solvers and the event's scheduler agent alike); this core factors out the
 * mechanics shared by all of them:
 *
 *  - per-id lock serialization (the caller's own `withLock`, so service-native
 *    action-error types survive),
 *  - a monotonic per-id turn generation so a stale turn's settle is a no-op
 *    when a newer turn has started,
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
  /** A turn is starting (status → running): mark the agent running. */
  onTurnStart?(id: string): void
  /** The freshest turn settled: consume a pending finish (graceful
   * self-termination) or mark the agent idle. `error` is the prompt error, if
   * any (already logged by the core). */
  onTurnSettled(id: string, error: string | null): void
  /** Called just before driving a fresh turn from send() (run: clear pending). */
  onBeforeNewTurn?(id: string): void
  /** Cold-resume a closed agent so send() can start a new turn. Omit to
   * reject sends to agents without a live session. */
  onResume?(id: string): Promise<void>
}

export type SessionLifecycle = {
  /** Live session map (every agent the service has warmed: solvers + the
   * event's scheduler agent). */
  get(id: string): HostAgentSession | undefined
  has(id: string): boolean
  set(id: string, session: HostAgentSession): void
  delete(id: string): void
  /** Deliver a message: steer / followUp while streaming, else a fresh turn.
   * Resolves false WITHOUT delivering when there is no live session and no
   * `onResume` can produce one, or `opts.assertLive` rejects the id inside
   * the lock before any resume (the delivery path re-checked liveness
   * outside the lock and may have lost a race to a concurrent close).
   * Resolves true once the text landed (steer/followUp queued or turn
   * driven). */
  send(
    id: string,
    text: string,
    deliverAs?: "steer" | "followUp",
    opts?: { assertLive?: (id: string) => boolean }
  ): Promise<boolean>
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
    void options
      .withLock(id, () => {
        if (turnGeneration.get(id) !== gen) return
        if (sessions.get(id) !== driven) return
        options.onTurnSettled(id, error)
      })
      .catch((err) => {
        // A service close mid-turn rejects the lock with invalid_state — a
        // settling turn racing shutdown is expected, not an error.
        if (err instanceof RunActionError && err.code === "invalid_state")
          return
        console.error(`${kind} settle failed`, {
          id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  async function send(
    id: string,
    text: string,
    deliverAs?: "steer" | "followUp",
    opts?: { assertLive?: (id: string) => boolean }
  ): Promise<boolean> {
    return options.withLock(id, async (): Promise<boolean> => {
      if (opts?.assertLive && !opts.assertLive(id)) return false
      let session = sessions.get(id)
      if (!session) {
        if (!options.onResume) return false
        await options.onResume(id)
        session = sessions.get(id)
        if (!session) return false
      }
      if (session.session.isStreaming) {
        if (deliverAs === "followUp") await session.session.followUp(text)
        else await session.session.steer(text)
        return true
      }
      options.onBeforeNewTurn?.(id)
      drive(id, text)
      return true
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
