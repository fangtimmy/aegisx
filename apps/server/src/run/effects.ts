import type { Clock, ClockTimer } from "./clock"
import { createTimerHub } from "./clock"

/**
 * Effect primitives over the time layer (control-plane design §4/C): the
 * recurring scheduling semantics run/ used to hand-roll per subsystem —
 * trailing coalescing, per-key serial single-flight, bounded self-wake —
 * declared instead of rebuilt from raw timer handles. Everything registers
 * on one TimerHub, so a module's close() collapses to
 * {@link Effects.dispose}, and an injected fake clock drives the whole
 * layer deterministically.
 */

/** The per-key state behind {@link Effects.debounce} and
 * {@link Effects.retry}: the two share a key so a fresh trigger supersedes a
 * pending self-wake (the pass it opens covers the same need) and a run in
 * flight holds the key until it settles. */
type Trigger = {
  fn: () => void | Promise<void>
  ms: number
  window: ClockTimer | null
  wake: ClockTimer | null
  /** The in-flight pass (fn's promise chain). A fire landing on a busy key
   * is consumed by the running pass; overwriting this would orphan the
   * mid-pass trigger tracking. */
  running: Promise<void> | null
  /** A trigger arrived mid-pass: open a fresh window once it settles. */
  rerun: boolean
}

export type Effects = {
  /**
   * Trailing-edge coalescing per key: the first call arms an `ms` window,
   * calls landing inside it are absorbed (no extension) and the window
   * fires `fn` once. A call arriving while an earlier run is still in
   * flight is not lost — a fresh window opens when that run settles. Also
   * supersedes a pending {@link Effects.retry} wake on the same key.
   */
  debounce(key: string, ms: number, fn: () => void | Promise<void>): void
  /**
   * Bounded self-wake per key (capacity-retry style): at most one pending
   * timer; when it fires it runs `fn` unless a pass is already in flight
   * on the key (that pass covers the wake). A {@link Effects.debounce}
   * trigger on the same key supersedes it.
   */
  retry(key: string, ms: number, fn: () => void | Promise<void>): void
  /**
   * Per-key serial single-flight: an idle chain starts `fn` synchronously
   * (an urgent trigger reaches its target without an extra tick); an
   * in-flight chain queues `fn` behind the previous run. Failures are
   * caught and logged — never propagated to the next task or the caller.
   */
  chain(key: string, fn: () => Promise<void>): void
  /** One-shot timer (TimerHub thin wrapper). Cancel via the handle. */
  after(ms: number, fn: () => void): ClockTimer
  /** Interval timer (TimerHub thin wrapper). Cancel via the handle. */
  every(ms: number, fn: () => void): ClockTimer
  /** Cancel one after/every timer (registry + underlying clock). */
  clear(timer: ClockTimer): void
  /** Cancel every timer and drop all per-key state (module close). */
  dispose(): void
}

export function createEffects(clock: Clock): Effects {
  const hub = createTimerHub(clock)
  const triggers = new Map<string, Trigger>()
  const chains = new Map<string, Promise<void>>()

  function triggerOf(key: string): Trigger {
    let trigger = triggers.get(key)
    if (!trigger) {
      trigger = {
        fn: () => undefined,
        ms: 0,
        window: null,
        wake: null,
        running: null,
        rerun: false,
      }
      triggers.set(key, trigger)
    }
    return trigger
  }

  function clearWake(trigger: Trigger): void {
    if (trigger.wake) {
      hub.clear(trigger.wake)
      trigger.wake = null
    }
  }

  function armWindow(trigger: Trigger, key: string): void {
    trigger.window = hub.setTimeout(() => {
      trigger.window = null
      fire(trigger, key)
    }, trigger.ms)
  }

  /** Run the pass now (window/wake firing paths). */
  function fire(trigger: Trigger, key: string): void {
    if (trigger.running) return
    trigger.running = Promise.resolve(trigger.fn())
      .catch((error) => {
        console.error("effect pass failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .then(() => settled(trigger, key))
  }

  /** The pass finished: honor a mid-pass trigger with a fresh window. */
  function settled(trigger: Trigger, key: string): void {
    trigger.running = null
    if (!trigger.rerun) return
    trigger.rerun = false
    clearWake(trigger)
    armWindow(trigger, key)
  }

  return {
    debounce(key, ms, fn) {
      const trigger = triggerOf(key)
      // An explicit trigger supersedes a pending self-wake.
      clearWake(trigger)
      if (trigger.running) {
        trigger.rerun = true
        return
      }
      if (trigger.window) return
      trigger.fn = fn
      trigger.ms = ms
      armWindow(trigger, key)
    },

    retry(key, ms, fn) {
      const trigger = triggerOf(key)
      if (trigger.wake) return
      trigger.fn = fn
      trigger.ms = ms
      trigger.wake = hub.setTimeout(() => {
        trigger.wake = null
        fire(trigger, key)
      }, ms)
    },

    chain(key, fn) {
      const prior = chains.get(key)
      const next = (prior ? prior.catch(() => undefined).then(fn) : fn()).catch(
        (error) => {
          console.error("effect chain failed", {
            key,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      )
      chains.set(key, next)
      void next.then(() => {
        if (chains.get(key) === next) chains.delete(key)
      })
    },

    after: (ms, fn) => hub.setTimeout(fn, ms),
    every: (ms, fn) => hub.setInterval(fn, ms),

    clear(timer) {
      hub.clear(timer)
    },

    dispose() {
      hub.disposeAll()
      triggers.clear()
      chains.clear()
    },
  }
}
