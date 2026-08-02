import type { LiveEvent } from "../../../shared"

type Listener = (event: LiveEvent) => void

/**
 * In-memory SSE fan-out. One bus per server; subscribers per runId (browser
 * tabs). Events are ephemeral — durable history lives in run_events and is
 * served by the messages API. Reconnect re-reads committed messages there,
 * then re-applies live progress from this stream.
 */
export function createLiveBus() {
  const subscribers = new Map<string, Set<Listener>>()
  // Latest run snapshot per runId, replayed to new subscribers so a fresh
  // EventSource connection immediately sees the current run/agent state.
  const lastRun = new Map<string, LiveEvent>()
  const lastAgent = new Map<string, LiveEvent>()

  function subscribe(runId: string, listener: Listener): () => void {
    let set = subscribers.get(runId)
    if (!set) {
      set = new Set()
      subscribers.set(runId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) subscribers.delete(runId)
    }
  }

  function emit(runId: string, event: LiveEvent) {
    if (event.type === "run.updated") lastRun.set(runId, event)
    if (event.type === "agent.updated") {
      lastAgent.set(event.agent.id, event)
    }
    const set = subscribers.get(runId)
    if (!set) return
    for (const listener of set) {
      try {
        listener(event)
      } catch (error) {
        console.error("live listener failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** Snapshot replayed to a freshly connected subscriber (before live events). */
  function replay(runId: string, listener: Listener) {
    const run = lastRun.get(runId)
    if (run) listener(run)
    // Only agents belonging to this run; lastAgent is keyed by agent id, so we
    // filter by runId embedded in run.updated/agent.updated flows via the caller.
  }

  function close() {
    subscribers.clear()
    lastRun.clear()
    lastAgent.clear()
  }

  return { subscribe, emit, replay, close }
}

export type LiveBus = ReturnType<typeof createLiveBus>
