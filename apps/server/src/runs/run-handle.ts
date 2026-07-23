import { RunActionError } from "./errors"

export type AbortReason = "paused" | "stopped"

/**
 * Per-run coordination: serial lock + abort-in-progress flag.
 * Session/container maps stay on the orchestrator/registry/pool.
 */
export function createRunHandleRegistry(options: { isClosed(): boolean }) {
  const locks = new Map<string, Promise<unknown>>()
  const aborting = new Map<string, AbortReason>()

  function withLock<T>(runId: string, operation: () => T | Promise<T>) {
    if (options.isClosed()) {
      return Promise.reject(
        new RunActionError("invalid_state", "Run manager is closed")
      )
    }
    const previous = locks.get(runId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    locks.set(runId, next)
    return next.finally(() => {
      if (locks.get(runId) === next) locks.delete(runId)
    })
  }

  function beginAbort(runId: string, reason: AbortReason) {
    aborting.set(runId, reason)
  }

  function endAbort(runId: string) {
    aborting.delete(runId)
  }

  function isAborting(runId: string) {
    return aborting.has(runId)
  }

  function abortReason(runId: string) {
    return aborting.get(runId)
  }

  async function drain() {
    await Promise.allSettled([...locks.values()])
  }

  function clear() {
    aborting.clear()
    locks.clear()
  }

  return {
    withLock,
    beginAbort,
    endAbort,
    isAborting,
    abortReason,
    drain,
    clear,
  }
}

export type RunHandleRegistry = ReturnType<typeof createRunHandleRegistry>
