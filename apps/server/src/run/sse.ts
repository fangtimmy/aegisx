import type { LiveEvent } from "@aegisx/shared/live-event"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import type { Principal } from "../infrastructure/agent-auth"
import { RunActionError } from "./errors"
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
          await stream.writeSSE({
            data: JSON.stringify(event),
            // The durable faces' replay cursor: EventSource echoes it back
            // as Last-Event-ID on reconnect. Only channel frames carry one
            // (the ledger row id — the global monotonic the replay reads).
            ...(event.type === "channel.message"
              ? { id: String(event.message.id) }
              : {}),
          })
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

/** The multiplexed live stream is the browser's face: one connection carries
 * every agent of every event. Agent tokens are already refused at the endpoint
 * level (agent-auth's verdict does not list `/api/stream`), so this repeats
 * the rule at the service layer — an in-process caller cannot bypass the
 * endpoint gate, and agents have no SSE consumer anyway (the SDK's read path
 * is REST). */
function assertMayWatchLive(principal: Principal): void {
  if (principal.kind === "agent") {
    throw new RunActionError(
      "forbidden",
      "实时流是用户界面专用面，agent 不消费全局 SSE"
    )
  }
}

/**
 * The single live event stream (EventSource) for the whole app: one
 * connection carries every agent's events plus every channel message, and
 * subscribers dispatch by the identity already in the payload (`agentId`,
 * `message.channelKey`). It replaces the per-agent and per-channel streams —
 * the bus is a global singleton, so there was never a reason for the browser
 * to hold one connection per agent.
 *
 * The initial snapshot replays each live agent's status + bus state (context /
 * queue / activity / in-flight tools) so a fresh connection — including a
 * reconnect — sees current state immediately, for every agent; the client
 * keeps it keyed by agentId and only renders what is on screen. There is no
 * `ready` frame any more: the EventSource's own `open` event is the readiness
 * signal, and a global ready had no id to carry. Channel timelines need no
 * snapshot beyond the replay below: their REST window + polling is the
 * durable source, live frames are the accelerator.
 *
 * Channel-face resume: every channel frame is stamped with the ledger row id
 * (`id:`), so a reconnecting EventSource presents Last-Event-ID and the seed
 * replays every ledger row past that cursor — subscribe-first still holds
 * (rows landing between replay and subscribe arrive live and are de-duplicated
 * client-side by message id). The session-entry face has no SSE replay:
 * committed frames carry `(sessionId, seq)` and the client catches up via
 * GET .../messages?after=<lastSeq> before resuming the live stream. Volatile
 * faces (tool deltas / context / activity) stay seed-before-subscribe
 * snapshots — their replay would be meaningless.
 */
export function streamLive(
  c: Context,
  service: AgentService,
  principal: Principal
): Response {
  assertMayWatchLive(principal)
  const bus = service.bus

  // The reconnect cursor (EventSource resends it automatically). A global
  // autoincrement ids every ledger row, so one cursor covers all channels.
  const lastEventId = Number.parseInt(c.req.header("last-event-id") ?? "", 10)
  const replayAfter =
    Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : null

  return pumpLiveStream(
    c,
    (listener) => bus.subscribeAll(listener),
    (push) => {
      if (replayAfter !== null) {
        for (const message of service.channels.replayAfter(replayAfter)) {
          push({ type: "channel.message", message })
        }
      }
      // Fresh snapshot (re-read after subscribe, not before).
      for (const agent of service.listAgents()) {
        push({ type: "agent.updated", agent })
        const context = bus.getContext(agent.id)
        if (context) push(context)
        const queueState = bus.getQueue(agent.id)
        if (queueState) push(queueState)
        const activity = bus.getActivity(agent.id)
        if (activity) push(activity)
        // Replay in-flight tools (with their latest partial result) so a
        // fresh connection sees an executing bash command's streamed output
        // right away.
        for (const tool of bus.getToolProgress(agent.id)) push(tool)
      }
      return true
    }
  )
}
