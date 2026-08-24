import type { LiveEvent } from "@aegisx/shared"

type Listener = (event: LiveEvent) => void

/**
 * In-memory SSE fan-out. One bus per server; subscribers per topic (browser
 * tabs). A topic is the LiveBus key — a run id for solver agents, an event id
 * for the orchestrator. Events are ephemeral; durable history lives in
 * session_entries and is served by the messages API.
 *
 * Reconnect correctness: the bus snapshots the latest `run` / `context` /
 * `queue` per topic/agent AND the current ephemeral state — the active
 * `agent.activity` plus every still-running `tool.progress` (carrying the last
 * partial result). The SSE route replays these to a freshly connected
 * EventSource so a new tab / refresh sees an in-progress bash command's
 * streamed output immediately, instead of only catching events that arrive
 * after connect. Snapshots are cleared the moment their event goes terminal
 * (tool done/error, activity null), so they never leak stale state.
 */
export function createLiveBus() {
  const subscribers = new Map<string, Set<Listener>>()
  const lastRun = new Map<string, LiveEvent>()
  const lastContext = new Map<string, LiveEvent>()
  const lastQueue = new Map<string, LiveEvent>()
  /** Latest non-null activity per agent (transient badge state). */
  const lastActivity = new Map<string, LiveEvent>()
  /** Running tool.progress per agent, keyed by toolCallId. Cleared on
   * done/error so only genuinely in-flight tools are replayed on connect. */
  const runningTools = new Map<string, Map<string, LiveEvent>>()

  function subscribe(topic: string, listener: Listener): () => void {
    let set = subscribers.get(topic)
    if (!set) {
      set = new Set()
      subscribers.set(topic, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) subscribers.delete(topic)
    }
  }

  function emit(topic: string, event: LiveEvent) {
    if (event.type === "run.updated") lastRun.set(topic, event)
    if (event.type === "context.updated") lastContext.set(event.agentId, event)
    if (event.type === "queue.updated") lastQueue.set(event.agentId, event)
    if (event.type === "agent.activity") {
      if (event.activity === null) lastActivity.delete(event.agentId)
      else lastActivity.set(event.agentId, event)
    }
    if (event.type === "tool.progress") {
      const perAgent = runningTools.get(event.agentId)
      if (event.status === "running") {
        const m = perAgent ?? new Map<string, LiveEvent>()
        m.set(event.toolCallId, event)
        runningTools.set(event.agentId, m)
      } else if (perAgent) {
        // tool_execution_end (done/error) is always emitted before the
        // toolResult is committed, so dropping here is enough — no need to
        // inspect committed entries for the matching toolCallId.
        perAgent.delete(event.toolCallId)
        if (perAgent.size === 0) runningTools.delete(event.agentId)
      }
    }
    const set = subscribers.get(topic)
    if (!set) return
    for (const listener of set) {
      try {
        listener(event)
      } catch (error) {
        console.error("live listener failed", {
          topic,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** Latest context snapshot for an agent (for SSE initial replay). */
  function getContext(agentId: string): LiveEvent | undefined {
    return lastContext.get(agentId)
  }

  /** Latest steer/followUp queue snapshot for an agent (for SSE initial replay). */
  function getQueue(agentId: string): LiveEvent | undefined {
    return lastQueue.get(agentId)
  }

  /** Latest activity for an agent (for SSE initial replay); undefined when idle. */
  function getActivity(agentId: string): LiveEvent | undefined {
    return lastActivity.get(agentId)
  }

  /** Running tool.progress events for an agent (for SSE initial replay), each
   * carrying its latest partial result. Empty when nothing is in flight. */
  function getToolProgress(agentId: string): LiveEvent[] {
    const m = runningTools.get(agentId)
    return m ? [...m.values()] : []
  }

  function close() {
    subscribers.clear()
    lastRun.clear()
    lastContext.clear()
    lastQueue.clear()
    lastActivity.clear()
    runningTools.clear()
  }

  return {
    subscribe,
    emit,
    getContext,
    getQueue,
    getActivity,
    getToolProgress,
    close,
  }
}

export type LiveBus = ReturnType<typeof createLiveBus>
