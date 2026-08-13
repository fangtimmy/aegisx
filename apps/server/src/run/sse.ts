import type { LiveEvent } from "@aegisx/shared/live-event"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { notFound } from "../infrastructure/http-errors"
import type { RunService } from "./service"

/**
 * Live run event stream (EventSource). Shared by the run-level stream and the
 * scheduler stream. Emits an initial snapshot (ready + run + per-agent state +
 * in-flight tools) so a fresh connection sees current state immediately, then
 * forwards bus events until the client disconnects. Reconnect re-reads durable
 * messages via GET .../messages.
 */
export function streamRun(
  c: Context,
  runService: RunService,
  runId: string
): Response {
  const detail = runService.detail(runId)
  if (!detail) return notFound(c, "Run not found")
  const entryAgent = detail.agents.find((a) => a.isEntry)
  const bus = runService.bus

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
    const unsubscribe = bus.subscribe(runId, (event) => {
      queue.push(event)
      drain()
    })

    queue.push({ type: "ready", runId, agentId: entryAgent?.id ?? "" })
    queue.push({ type: "run.updated", run: detail.run })
    for (const agent of detail.agents) {
      queue.push({ type: "agent.updated", agent })
      const context = bus.getContext(agent.id)
      if (context) queue.push(context)
      const queueState = bus.getQueue(agent.id)
      if (queueState) queue.push(queueState)
      const activity = bus.getActivity(agent.id)
      if (activity) queue.push(activity)
      // Replay in-flight tools (with their latest partial result) so a fresh
      // connection sees an executing bash command's streamed output right away.
      for (const tool of bus.getToolProgress(agent.id)) queue.push(tool)
    }

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
