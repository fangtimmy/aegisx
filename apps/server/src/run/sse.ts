import type { LiveEvent } from "@aegisx/shared/live-event"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import type { Principal } from "../infrastructure/agent-auth"
import { parseChannelKey } from "./channels"
import { assertMayTouchAgent } from "./principal-scope"
import type { AgentService } from "./service"

/** The two streaming variants the pipeline stamps with a monotonic
 * `revision`; everything else on the wire is a one-shot frame. */
type ProgressEvent = Extract<LiveEvent, { revision: number }>

function isProgressEvent(event: LiveEvent): event is ProgressEvent {
  return event.type === "message.progress" || event.type === "tool.progress"
}

/** Identity of an in-flight stream: one agent's streaming message draft or
 * one executing tool. A newer revision of the same identity supersedes all
 * earlier ones (each frame carries the WHOLE accumulated message / latest
 * tool state, so older copies are pure redundancy). */
function coalesceKeyOf(event: ProgressEvent): string {
  const id = event.type === "message.progress" ? event.key : event.toolCallId
  return `${event.agentId}|${event.type}|${id}`
}

/**
 * Bounded buffer for the SSE pump: `message.progress` / `tool.progress`
 * frames collapse to the highest revision per identity (replacing in the
 * arrival slot of the first frame, so relative order to other frames is
 * preserved), while every other event passes through in order. A long
 * streaming reply to a slow client therefore holds ONE frame per active
 * identity instead of thousands of ever-growing copies.
 */
export function createProgressCoalescer() {
  let pending: LiveEvent[] = []
  const slots = new Map<string, number>()
  return {
    get size(): number {
      return pending.length
    },
    push(event: LiveEvent): void {
      if (!isProgressEvent(event)) {
        pending.push(event)
        return
      }
      const key = coalesceKeyOf(event)
      const at = slots.get(key)
      if (at === undefined) {
        slots.set(key, pending.length)
        pending.push(event)
        return
      }
      const held = pending[at]
      if (isProgressEvent(held) && event.revision > held.revision) {
        pending[at] = event
      }
    },
    /** Take everything buffered, in order, and reset for the next batch. */
    drain(): LiveEvent[] {
      const out = pending
      pending = []
      slots.clear()
      return out
    },
  }
}

/** Shared SSE pump (EventSource): subscribe BEFORE seeding the snapshot so no
 * event between the snapshot read and the subscribe is missed — duplicates
 * (an event in both snapshot and queue) are harmless, the UI handles them
 * idempotently (progress frames with equal revisions even coalesce away).
 * `seed` returns false to close immediately (e.g. unknown agent). onAbort
 * wakes a pending idle wait so the loop exits and the subscription never
 * leaks. */
function pumpLiveStream(
  c: Context,
  subscribe: (listener: (event: LiveEvent) => void) => () => void,
  seed: (push: (event: LiveEvent) => void) => boolean
): Response {
  return streamSSE(c, async (stream) => {
    let aborted = false
    const coalescer = createProgressCoalescer()
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
      coalescer.push(event)
      drain()
    })

    try {
      if (!seed((event) => coalescer.push(event))) return
      for (;;) {
        if (coalescer.size === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve
          })
          if (aborted) break
        }
        for (const event of coalescer.drain()) {
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
  agentId: string,
  principal: Principal
): Response {
  // Existence (404) is the route's business; the scope check is here so the
  // stream face is guarded at the same layer as every other agent op.
  const agent = service.getAgent(agentId)
  if (agent) assertMayTouchAgent(principal, agent)
  const bus = service.bus

  return pumpLiveStream(
    c,
    (listener) => bus.subscribe(agentId, listener),
    (push) => {
      // Fresh snapshot (re-read after subscribe, not before).
      const detail = service.getAgentDetail(agentId, principal)
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
          // Server-side filter parity with the snapshot: a bus channel fans
          // out several channel keys (a #team post also rides the event
          // channel) — forward only messages of THIS request's key.
          if (
            event.type === "channel.message" &&
            event.message.channelKey === channelKey
          ) {
            listener(event)
          }
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
