import type { LiveEvent } from "../../../shared"

type Listener = (event: LiveEvent) => void

/**
 * In-memory SSE fan-out. One bus per server; subscribers per channel (browser
 * tabs). A channel is the LiveBus key — a run id for solver agents, an event id
 * for the orchestrator. Events are ephemeral; durable history lives in
 * session_entries and is served by the messages API. Reconnect re-reads
 * committed entries there, then re-applies live progress from this stream.
 */
export function createLiveBus() {
  const subscribers = new Map<string, Set<Listener>>()
  // Latest run snapshot per channel, replayed to new subscribers so a fresh
  // EventSource connection immediately sees the current run/agent state.
  const lastRun = new Map<string, LiveEvent>()
  const lastAgent = new Map<string, LiveEvent>()
  // Latest per-agent context + queue snapshots (keyed by agentId), replayed to
  // new subscribers so the stat strip / steer queue render immediately.
  const lastContext = new Map<string, LiveEvent>()
  const lastQueue = new Map<string, LiveEvent>()

  function subscribe(channel: string, listener: Listener): () => void {
    let set = subscribers.get(channel)
    if (!set) {
      set = new Set()
      subscribers.set(channel, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) subscribers.delete(channel)
    }
  }

  function emit(channel: string, event: LiveEvent) {
    if (event.type === "run.updated") lastRun.set(channel, event)
    if (event.type === "agent.updated") {
      lastAgent.set(event.agent.id, event)
    }
    if (event.type === "context.updated") lastContext.set(event.agentId, event)
    if (event.type === "queue.updated") lastQueue.set(event.agentId, event)
    const set = subscribers.get(channel)
    if (!set) return
    for (const listener of set) {
      try {
        listener(event)
      } catch (error) {
        console.error("live listener failed", {
          channel,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** Snapshot replayed to a freshly connected subscriber (before live events). */
  function replay(channel: string, listener: Listener) {
    const run = lastRun.get(channel)
    if (run) listener(run)
    // Only agents belonging to this run; lastAgent is keyed by agent id, so we
    // filter by channel embedded in run.updated/agent.updated flows via the caller.
  }

  /** Latest context snapshot for an agent (for SSE initial replay). */
  function getContext(agentId: string): LiveEvent | undefined {
    return lastContext.get(agentId)
  }

  /** Latest steer/followUp queue snapshot for an agent (for SSE initial replay). */
  function getQueue(agentId: string): LiveEvent | undefined {
    return lastQueue.get(agentId)
  }

  function close() {
    subscribers.clear()
    lastRun.clear()
    lastAgent.clear()
    lastContext.clear()
    lastQueue.clear()
  }

  return { subscribe, emit, replay, getContext, getQueue, close }
}

export type LiveBus = ReturnType<typeof createLiveBus>
