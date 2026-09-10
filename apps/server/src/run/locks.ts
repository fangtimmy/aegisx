/** Per-key promise-chaining lock: serialize async ops under the same key. Each
 * op waits for the previous one (success or failure) before running, and the
 * map entry is cleared once the chain drains. Shared by the run service's
 * `withLock` / `withFence` / per-event start locks, which add their own
 * closed-check and bespoke action error type on top. */
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
