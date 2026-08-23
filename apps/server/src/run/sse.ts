import type { LiveEvent } from "@aegisx/shared/live-event"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { parseChannelKey } from "./channels"
import type { AgentService } from "./service"

/** Shared SSE pump (EventSource): subscribe BEFORE seeding the snapshot so no
 * event between the snapshot read and the subscribe is missed — duplicates
 * (an event in both snapshot and queue) are harmless, the UI handles them
 * idempotently. `seed` returns false to close immediately (e.g. unknown
 * agent). onAbort wakes a pending idle wait so the loop exits and the
 * subscription never leaks. */
function pumpLiveStream(
  c: Context,
  subscribe: (listener: (event: LiveEvent) => void) => () => void,
  seed: (push: (event: LiveEvent) => void) => boolean
): Response {
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
    stream.onAbort(() => {
      aborted = true
      drain()
    })
    const unsubscribe = subscribe((event) => {
      queue.push(event)
      drain()
    })

    try {
      if (!seed((event) => queue.push(event))) return
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve
          })
          if (aborted) break
        }
        while (queue.length > 0) {
          const event = queue.shift()
          if (!event) break
          await stream.writeSSE({ data: JSON.stringify(event) })
        }
        if (aborted) break
      }
    } catch {
      // client gone
    } finally {
      unsubscribe()
    }
  })
}

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

  return pumpLiveStream(
    c,
    (listener) => bus.subscribe(agentId, listener),
    (push) => {
      // Fresh snapshot (re-read after subscribe, not before).
      const detail = service.getAgentDetail(agentId)
      if (!detail) return false
      push({ type: "ready", agentId })
      push({ type: "agent.updated", agent: detail.agent })
      const context = bus.getContext(agentId)
      if (context) push(context)
      const queueState = bus.getQueue(agentId)
      if (queueState) push(queueState)
      const activity = bus.getActivity(agentId)
      if (activity) push(activity)
      // Replay in-flight tools (with their latest partial result) so a fresh
      // connection sees an executing bash command's streamed output right away.
      for (const tool of bus.getToolProgress(agentId)) push(tool)
      return true
    }
  )
}

/**
 * Live channel message stream (IM view). Initial snapshot = the channel's
 * latest message window, then live `channel.message` pushes only. The bus
 * channel(s) of a derived key differ from the key itself (dm → agentId,
 * orch → eventId, team → eventId + challengeId — `emitChannelsOf` is the
 * single mapping source). Reconnect replays the snapshot; the client
 * de-duplicates by message id.
 */
export function streamChannel(
  c: Context,
  service: AgentService,
  channelKey: string
): Response {
  const parsed = parseChannelKey(channelKey)!
  const busChannels = service.channels.emitChannelsOf(parsed)

  return pumpLiveStream(
    c,
    (listener) => {
      const unsubscribers = busChannels.map((channel) =>
        service.bus.subscribe(channel, (event) => {
          if (event.type === "channel.message") listener(event)
        })
      )
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
      }
    },
    (push) => {
      const snapshot = service.channels.listMessages(channelKey, {
        after: 0,
        limit: 50,
      })
      for (const message of snapshot.items) {
        push({ type: "channel.message", message })
      }
      return true
    }
  )
}
