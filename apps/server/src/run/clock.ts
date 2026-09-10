/**
 * The unified time layer (architecture review 2026-09-10, proposal 2): a
 * `Clock` (time source + timer factory) plus a `TimerHub` (per-module timer
 * registry). Every runtime timer in `run/` is created through this layer —
 * never from the bare globals — so `service.close()` converges on registry
 * disposal and tests can inject a {@link createFakeClock} for deterministic
 * time instead of real sleeps.
 */

/** Opaque handle of a timer created through a {@link Clock}. Cancelling is
 * idempotent: clearing a fired or already-cleared timer is a no-op. */
export type ClockTimer = { clear(): void }

/** Millisecond time source + timer factory. The whole runtime reads time and
 * schedules work through this interface only. */
export type Clock = {
  /** Wall time in milliseconds (monotonicity is NOT promised — same contract
   * as Date.now()). */
  now(): number
  setTimeout(callback: () => void, ms: number): ClockTimer
  setInterval(callback: () => void, ms: number): ClockTimer
  /** Promise resolved after `ms` (the promise-side of setTimeout). */
  sleep(ms: number): Promise<void>
}

/** The production clock: a thin wrapper over the global Date.now /
 * setTimeout / setInterval. Stateless — sharing one instance or using the
 * export directly is equivalent. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const id = setTimeout(callback, ms)
    return { clear: () => clearTimeout(id) }
  },
  setInterval(callback, ms) {
    const id = setInterval(callback, ms)
    return { clear: () => clearInterval(id) }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Timer registry around one {@link Clock}: every timer it creates is tracked,
 * so a module's `close()` collapses to {@link TimerHub.disposeAll} instead of
 * hand-managed handle maps. Per-timer cancel stays available for keyed
 * lifetimes (a settled agent's deadline timer). */
export type TimerHub = {
  setTimeout(callback: () => void, ms: number): ClockTimer
  setInterval(callback: () => void, ms: number): ClockTimer
  /** Cancel one timer (fired one-shots are already unregistered; still a
   * safe no-op). */
  clear(timer: ClockTimer): void
  /** Cancel every timer still registered (module close). */
  disposeAll(): void
}

export function createTimerHub(clock: Clock): TimerHub {
  const timers = new Set<ClockTimer>()
  return {
    setTimeout(callback, ms) {
      const timer = clock.setTimeout(() => {
        timers.delete(timer)
        callback()
      }, ms)
      timers.add(timer)
      return timer
    },
    setInterval(callback, ms) {
      const timer = clock.setInterval(callback, ms)
      timers.add(timer)
      return timer
    },
    clear(timer) {
      timers.delete(timer)
      timer.clear()
    },
    disposeAll() {
      for (const timer of timers) timer.clear()
      timers.clear()
    },
  }
}

/** A {@link Clock} whose time only moves when a test pushes it. `advance`
 * fires due callbacks synchronously, in due-time (then scheduling) order —
 * timers armed by a callback within the advanced window fire in the same
 * pass. */
export type FakeClock = Clock & {
  /** Move virtual time forward `ms` and fire everything that comes due. */
  advance(ms: number): void
  /** Timers currently scheduled (an armed interval counts once). */
  pendingCount(): number
}

/** Fresh fake clock. `startMs` defaults to the real wall time so fake time
 * and pre-seeded real-timestamp data (DB rows) stay comparable. */
export function createFakeClock(startMs = Date.now()): FakeClock {
  let nowMs = startMs
  let seq = 0
  const timers = new Map<number, FakeTimer>()

  type FakeTimer = {
    id: number
    at: number
    /** >0: interval, re-armed at += interval; null: one-shot. */
    every: number | null
    callback: () => void
  }

  function schedule(
    at: number,
    every: number | null,
    callback: () => void
  ): ClockTimer {
    const id = ++seq
    timers.set(id, { id, at, every, callback })
    return {
      clear: () => {
        timers.delete(id)
      },
    }
  }

  /** Earliest timer due at or before `limit` (ties by scheduling order). */
  function nextDue(limit: number): FakeTimer | undefined {
    let best: FakeTimer | undefined
    for (const entry of timers.values()) {
      if (entry.at > limit) continue
      if (
        !best ||
        entry.at < best.at ||
        (entry.at === best.at && entry.id < best.id)
      ) {
        best = entry
      }
    }
    return best
  }

  const clock: FakeClock = {
    now: () => nowMs,
    setTimeout(callback, ms) {
      return schedule(nowMs + Math.max(0, ms), null, callback)
    },
    // Like the native timer, a sub-millisecond interval ticks on 1ms — keeps
    // advance() terminating on a 0ms interval.
    setInterval(callback, ms) {
      const step = Math.max(1, ms)
      return schedule(nowMs + step, step, callback)
    },
    sleep(ms) {
      return new Promise((resolve) => {
        clock.setTimeout(resolve, ms)
      })
    },
    advance(ms) {
      const target = nowMs + Math.max(0, ms)
      for (let due = nextDue(target); due; due = nextDue(target)) {
        nowMs = due.at
        if (due.every !== null) due.at += due.every
        else timers.delete(due.id)
        due.callback()
      }
      nowMs = target
    },
    pendingCount: () => timers.size,
  }
  return clock
}
