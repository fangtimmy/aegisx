import type { LiveEvent } from "../../../shared"

export type LiveListener = (event: LiveEvent) => void

/** In-memory live SSE fan-out (no durable cursor). */
export function createLiveBus() {
  const listeners = new Map<string, Set<LiveListener>>()

  function emit(runId: string, event: LiveEvent) {
    for (const listener of listeners.get(runId) ?? []) {
      listener(event)
    }
  }

  function subscribe(runId: string, listener: LiveListener) {
    const set = listeners.get(runId) ?? new Set()
    set.add(listener)
    listeners.set(runId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(runId)
    }
  }

  function clearRun(runId: string) {
    listeners.delete(runId)
  }

  function clear() {
    listeners.clear()
  }

  return { emit, subscribe, clearRun, clear }
}

export type LiveBus = ReturnType<typeof createLiveBus>
