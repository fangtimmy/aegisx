import type { LiveEvent } from "@aegisx/shared/live-event"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import type { AgentService } from "./service"

/**
 * Live agent event stream (EventSource). Emits an initial snapshot (ready +
 * the agent + its bus state: context / queue / activity / in-flight tools)
 * so a fresh connection sees current state immediately, then forwards bus
 * events on the agent's channel until the client disconnects. Reconnect
 * re-reads durable messages via GET .../messages.
 */
export function streamAgent(
  c: Context,
  service: AgentService,
  agentId: string
): Response {
  const bus = service.bus

  return streamSSE(c, async (stream) => {
    let aborted = false
    const queue: LiveEvent[] = []
    let resolveNext: (() => void) | null = null
    const drain = () => {
      if (resolveNext) {
        const fn = resolveNext
        resolveNext = null
        fn()
      }
    }
    // Wake a pending idle wait on abort too — otherwise the await never
    // resolves, the loop never exits, and the subscription leaks.
    stream.onAbort(() => {
      aborted = true
      drain()
    })
    // Subscribe BEFORE the initial snapshot so no event between snapshot
    // read and subscribe is missed. Duplicates (event X in both snapshot and
    // queue) are harmless — the UI handles them idempotently.
    const unsubscribe = bus.subscribe(agentId, (event) => {
      queue.push(event)
      drain()
    })

    // Fresh snapshot (re-read after subscribe, not before).
    const detail = service.getAgentDetail(agentId)
    if (!detail) {
      unsubscribe()
      return
    }
    queue.push({ type: "ready", agentId })
    queue.push({ type: "agent.updated", agent: detail.agent })
    const context = bus.getContext(agentId)
    if (context) queue.push(context)
    const queueState = bus.getQueue(agentId)
    if (queueState) queue.push(queueState)
    const activity = bus.getActivity(agentId)
    if (activity) queue.push(activity)
    // Replay in-flight tools (with their latest partial result) so a fresh
    // connection sees an executing bash command's streamed output right away.
    for (const tool of bus.getToolProgress(agentId)) queue.push(tool)

    try {
      while (!aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve
          })
          if (aborted) break
        }
        while (queue.length > 0) {
          const event = queue.shift() as LiveEvent
          await stream.writeSSE({ data: JSON.stringify(event) })
        }
      }
    } catch {
      // client gone
    } finally {
      unsubscribe()
    }
  }) as Response
}
