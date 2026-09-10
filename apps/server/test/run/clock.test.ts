import { describe, expect, test } from "bun:test"

import {
  createFakeClock,
  createTimerHub,
  systemClock,
} from "../../src/run/clock"

/** Macrotask yield: lets the real clock's timer callbacks run before the
 * assertions (fake-clock paths fire synchronously and need no yield). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("systemClock (real)", () => {
  test("now() reads the wall clock", () => {
    const before = Date.now()
    const now = systemClock.now()
    const after = Date.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(after)
  })

  test("setTimeout fires once; clear() cancels before the fire", async () => {
    const clock = systemClock
    let fired = 0
    clock.setTimeout(() => fired++, 5)
    const cancelled = clock.setTimeout(() => fired++, 5)
    cancelled.clear()
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(fired).toBe(1)
  })

  test("setInterval repeats until cleared", async () => {
    let fired = 0
    const timer = systemClock.setInterval(() => fired++, 5)
    await new Promise((resolve) => setTimeout(resolve, 18))
    timer.clear()
    const afterClear = fired
    expect(afterClear).toBeGreaterThanOrEqual(2)
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(fired).toBe(afterClear)
  })

  test("sleep resolves in scheduling order (no wall-time bounds — Bun timers drift under load)", async () => {
    const order: number[] = []
    await Promise.all([
      systemClock.sleep(30).then(() => order.push(1)),
      systemClock.sleep(10).then(() => order.push(2)),
    ])
    expect(order).toEqual([2, 1])
  })
})

describe("createTimerHub", () => {
  test("tracks handles; clear() cancels one, disposeAll() cancels the rest", async () => {
    const clock = createFakeClock()
    const hub = createTimerHub(clock)
    let a = 0
    let b = 0
    let c = 0
    hub.setTimeout(() => a++, 10)
    const interval = hub.setInterval(() => b++, 5)
    const cancelled = hub.setTimeout(() => c++, 10)

    hub.clear(cancelled)
    expect(clock.pendingCount()).toBe(2)

    clock.advance(10)
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(c).toBe(0)

    hub.clear(interval)
    clock.advance(100)
    expect(b).toBe(2)

    // A fired one-shot is already unregistered; clearing it again is a no-op.
    expect(clock.pendingCount()).toBe(0)
    hub.disposeAll()
    expect(clock.pendingCount()).toBe(0)
  })

  test("disposeAll cancels pending timers (module close path)", () => {
    const clock = createFakeClock()
    const hub = createTimerHub(clock)
    let fired = 0
    hub.setTimeout(() => fired++, 50)
    hub.setInterval(() => fired++, 50)
    expect(clock.pendingCount()).toBe(2)
    hub.disposeAll()
    expect(clock.pendingCount()).toBe(0)
    clock.advance(1000)
    expect(fired).toBe(0)
  })
})

describe("createFakeClock", () => {
  test("advance moves now() and fires due timers in due-time order (ties by scheduling order)", () => {
    const clock = createFakeClock(1000)
    const order: string[] = []
    clock.setTimeout(() => order.push("later"), 20)
    clock.setTimeout(() => order.push("tied-first"), 10)
    clock.setTimeout(() => order.push("tied-second"), 10)
    clock.advance(20)
    expect(order).toEqual(["tied-first", "tied-second", "later"])
    expect(clock.now()).toBe(1020)
  })

  test("one-shots fire exactly once; advance stops at the target", () => {
    const clock = createFakeClock()
    let fired = 0
    clock.setTimeout(() => fired++, 100)
    clock.advance(50)
    expect(fired).toBe(0)
    clock.advance(50)
    expect(fired).toBe(1)
    clock.advance(1000)
    expect(fired).toBe(1)
  })

  test("intervals re-arm and repeat on every advance", () => {
    const clock = createFakeClock()
    let fired = 0
    clock.setInterval(() => fired++, 30)
    clock.advance(90)
    expect(fired).toBe(3)
    clock.advance(30)
    expect(fired).toBe(4)
  })

  test("timers armed during advance still fire within the same window", () => {
    const clock = createFakeClock()
    const order: string[] = []
    clock.setTimeout(() => {
      order.push("outer")
      clock.setTimeout(() => order.push("inner"), 10)
    }, 10)
    clock.advance(20)
    expect(order).toEqual(["outer", "inner"])
  })

  test("sleep resolves when advance passes the deadline", async () => {
    const clock = createFakeClock()
    let done = false
    const pending = clock.sleep(500).then(() => {
      done = true
    })
    expect(done).toBe(false)
    clock.advance(499)
    expect(done).toBe(false)
    clock.advance(1)
    // The resolve ran synchronously inside advance; flush the continuation.
    await Promise.resolve()
    expect(done).toBe(true)
    await pending
  })

  test("advance fires nothing when no timer is due", () => {
    const clock = createFakeClock(0)
    clock.advance(10_000)
    expect(clock.now()).toBe(10_000)
    expect(clock.pendingCount()).toBe(0)
  })

  test("clear cancels a pending timer", () => {
    const clock = createFakeClock()
    let fired = 0
    const timer = clock.setTimeout(() => fired++, 10)
    timer.clear()
    clock.advance(100)
    expect(fired).toBe(0)
  })
})
