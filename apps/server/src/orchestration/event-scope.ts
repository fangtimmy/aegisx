import type { EventScopeEvent, EventScopePayload } from "./types"

/**
 * Per-event emitter for run lifecycle events. One per event, owned by the
 * scheduler (event-scoped) run; child-run lifecycle events (idle /
 * flagAccepted / finished / timedOut) are dispatched here so the built-in
 * scheduler wake-up subscriptions fire. Callbacks fire wrapped in try/catch —
 * a throwing callback never escapes (log + swallow). Created lazily when a
 * scheduler run's context is built; cleared when it closes.
 */
export class EventScopeEmitter {
  private readonly subs = new Map<
    EventScopeEvent,
    Set<(e: EventScopePayload) => void>
  >()

  on<E extends EventScopeEvent>(
    event: E,
    cb: (e: Extract<EventScopePayload, { type: E }>) => void
  ): () => void {
    let set = this.subs.get(event)
    if (!set) {
      set = new Set()
      this.subs.set(event, set)
    }
    // The stored callback is invoked with payloads of its own type only
    // (emit dispatches by payload.type), so the widening is sound.
    set.add(cb as (e: EventScopePayload) => void)
    return () => set!.delete(cb as (e: EventScopePayload) => void)
  }

  emit(payload: EventScopePayload): void {
    const set = this.subs.get(payload.type)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (error) {
        console.error("event-scope on() callback threw", {
          event: payload.type,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  close(): void {
    this.subs.clear()
  }
}
