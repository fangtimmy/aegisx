import type { LiveEvent } from "@aegisx/shared"

type Listener = (event: LiveEvent) => void

/**
 * In-memory SSE fan-out. One bus per server; subscribers per channel (browser
 * tabs) plus global subscribers that take every channel (the multiplexed
 * `/api/stream` face). A channel is the LiveBus key — the agent id for
 * agent-scoped events (plus the event/challenge ids the channel layer pushes
 * to). Events are ephemeral; durable history lives in session_entries and is
 * served by the messages API.
 *
 * Reconnect correctness: the bus snapshots the latest `context` / `queue`
 * per agent AND the current ephemeral state — the active `agent.activity`
 * plus every still-running `tool.progress` (carrying the last partial
 * result). The SSE route replays these to a freshly connected EventSource
 * so a new tab / refresh sees an in-progress bash command's streamed output
 * immediately, instead of only catching events that arrive after connect.
 * Snapshots are cleared the moment their event goes terminal (tool
 * done/error, activity null), so they never leak stale state.
 *
 * Ownership: the bus owns these snapshot caches outright and knows nothing
 * about AgentRuntime or agent terminal status — it sits in the host layer and
 * must not reach up into the run orchestration. The runtime's single terminal
 * path owns eviction: it detaches the session pipeline (so no further event
 * can be emitted) and only then calls {@link forget}. `close()` is the only
 * other wipe, for whole-service shutdown.
 */
export function createLiveBus() {
  /** Every emit, regardless of channel — the multiplexed stream subscribes
   * here instead of enumerating channel keys (an agent/challenge created
   * after connect would never be enumerated, so per-channel subscription
   * could not build a correct global stream). The emitted key stays in the
   * event payload for identity/diagnostics; routing is global-only. */
  const allSubscribers = new Set<Listener>()
  const lastContext = new Map<string, LiveEvent>()
  const lastQueue = new Map<string, LiveEvent>()
  /** Latest non-null activity per agent (transient badge state). */
  const lastActivity = new Map<string, LiveEvent>()
  /** Running tool.progress per agent, keyed by toolCallId. Cleared on
   * done/error so only genuinely in-flight tools are replayed on connect. */
  const runningTools = new Map<string, Map<string, LiveEvent>>()

  /** Global subscription: every emitted event, in emit order. */
  function subscribeAll(listener: Listener): () => void {
    allSubscribers.add(listener)
    return () => {
      allSubscribers.delete(listener)
    }
  }

  function emit(channel: string, event: LiveEvent) {
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
    const deliver = (listener: Listener) => {
      try {
        listener(event)
      } catch (error) {
        console.error("live listener failed", {
          channel,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    for (const listener of allSubscribers) deliver(listener)
  }

  /** Latest context snapshot for an agent (for SSE initial replay). */
  function getContext(agentId: string): LiveEvent | undefined {
    return lastContext.get(agentId)
  }

  /** Drop the per-agent snapshots (context / queue / activity / running
   * tools) for a closed agent. Called on agent teardown — long-lived memory
   * stays flat; a reopened agent rebuilds them from the first post-resume
   * events. */
  function forget(agentIds: string[]): void {
    for (const agentId of agentIds) {
      lastContext.delete(agentId)
      lastQueue.delete(agentId)
      lastActivity.delete(agentId)
      runningTools.delete(agentId)
    }
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
    allSubscribers.clear()
    lastContext.clear()
    lastQueue.clear()
    lastActivity.clear()
    runningTools.clear()
  }

  return {
    subscribeAll,
    emit,
    getContext,
    getQueue,
    getActivity,
    getToolProgress,
    forget,
    close,
  }
}

export type LiveBus = ReturnType<typeof createLiveBus>
