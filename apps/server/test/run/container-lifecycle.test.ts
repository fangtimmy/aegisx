import { afterEach, describe, expect, setSystemTime, test } from "bun:test"

import type { Database } from "../../src/db"
import {
  createContainerLifecycle,
  type ContainerLifecycle,
} from "../../src/run/container-lifecycle"
import type { ContainerManager } from "../../src/run/container/container-manager"
import { seedAgent, seedChallenge, seedEvent, setupDb } from "../helpers"
import { refine } from "../support"

/**
 * Recording ContainerManager fake: `isRunning` consults a mutable per-name
 * map (default running), `kill` records (name, signal) — enough to tell
 * SIGTERM teardown from the forced SIGKILL path.
 */
function fakeContainerManager() {
  const running = new Map<string, boolean>()
  const kills: Array<{ name: string; signal: "SIGTERM" | "SIGKILL" }> = []
  const manager = refine<ContainerManager>({
    isRunning: async (name: string) => running.get(name) ?? true,
    kill: async (name: string, signal: "SIGTERM" | "SIGKILL") => {
      kills.push({ name, signal })
    },
  })
  return {
    manager,
    kills,
    setRunning: (name: string, value: boolean) => {
      running.set(name, value)
    },
  }
}

type FakeTimeout = {
  fn: () => void
  delay: number
  cleared: boolean
  fired: boolean
  run: () => void
}

/**
 * Swap globalThis.setTimeout/clearTimeout for recording fakes. The force-kill
 * grace (FORCE_KILL_GRACE_MS = 10s) has no test knob, so tests capture the
 * armed timer and invoke it manually to simulate grace expiry. install/restore
 * must bracket a purely synchronous section.
 */
function captureTimeouts() {
  const timers: FakeTimeout[] = []
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const install = () => {
    globalThis.setTimeout = refine<typeof setTimeout>(
      (fn: () => void, delay?: number) => {
        const timer: FakeTimeout = {
          fn,
          delay: delay ?? 0,
          cleared: false,
          fired: false,
          run() {
            if (timer.cleared || timer.fired) return
            timer.fired = true
            timer.fn()
          },
        }
        timers.push(timer)
        return refine<NodeJS.Timeout>(timer)
      }
    )
    globalThis.clearTimeout = refine<typeof clearTimeout>((handle: unknown) => {
      const found = timers.find((timer) => timer === handle)
      if (found) {
        found.cleared = true
        return
      }
      realClear(refine<NodeJS.Timeout>(handle))
    })
  }
  const restore = () => {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  return { timers, install, restore }
}

/** Same seam for the sweep interval so close() is observable. */
function captureIntervals() {
  const intervals: Array<{ fn: () => void; cleared: boolean }> = []
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const install = () => {
    globalThis.setInterval = refine<typeof setInterval>((fn: () => void) => {
      const interval = { fn, cleared: false }
      intervals.push(interval)
      return refine<NodeJS.Timeout>(interval)
    })
    globalThis.clearInterval = refine<typeof clearInterval>(
      (handle: unknown) => {
        const found = intervals.find((interval) => interval === handle)
        if (found) {
          found.cleared = true
          return
        }
        realClear(refine<NodeJS.Timeout>(handle))
      }
    )
  }
  const restore = () => {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
  return { intervals, install, restore }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.toReversed()) {
    try {
      fn()
    } catch {
      // best-effort teardown
    }
  }
  cleanups.length = 0
})

function makeDb(): Database {
  const handle = setupDb()
  cleanups.push(handle.close)
  return handle.db
}

function makeLifecycle(
  db: Database,
  manager: ContainerManager,
  idleTtlMs = 60_000
): ContainerLifecycle {
  // Sweep interval far beyond any test lifetime; sweeps are invoked directly.
  const lifecycle = createContainerLifecycle({
    db,
    containerManager: manager,
    sweepIntervalMs: 3_600_000,
    idleTtlMs,
  })
  cleanups.push(() => lifecycle.close())
  return lifecycle
}

/** Let pending microtasks/promises settle (kill calls are fire-and-forget). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const ensureOpts = (key: string, containerName: string, sweepable = true) => ({
  key,
  containerName,
  sweepable,
})

describe("container lifecycle", () => {
  test("ensureContainer is single-flighted per key", async () => {
    const db = makeDb()
    const { manager } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)

    let builds = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const build = async () => {
      builds += 1
      await gate
    }

    const opts = ensureOpts("ch-1", "c-ch-1")
    const first = lifecycle.ensureContainer(opts, build)
    const second = lifecycle.ensureContainer(opts, build)
    release()
    await Promise.all([first, second])

    expect(builds).toBe(1)
    expect(lifecycle.registered("ch-1")).toBe(true)
    expect(await lifecycle.isRunning("ch-1")).toBe(true)

    // A registered, running container is reused — no rebuild.
    await lifecycle.ensureContainer(opts, async () => {
      builds += 1
    })
    expect(builds).toBe(1)
  })

  test("a failed build rejects every waiter once and clears the in-flight slot", async () => {
    const db = makeDb()
    const { manager } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)

    let builds = 0
    const failing = async () => {
      builds += 1
      throw new Error("docker down")
    }
    const opts = ensureOpts("ch-1", "c-ch-1")
    const first = lifecycle
      .ensureContainer(opts, failing)
      .catch((error) => error)
    const second = lifecycle
      .ensureContainer(opts, failing)
      .catch((error) => error)
    const [firstError, secondError] = await Promise.all([first, second])

    expect(builds).toBe(1)
    expect(refine<Error>(firstError).message).toBe("docker down")
    expect(refine<Error>(secondError).message).toBe("docker down")
    expect(lifecycle.registered("ch-1")).toBe(false)

    // The failed attempt left no poisoned state: a retry builds fresh.
    await lifecycle.ensureContainer(opts, async () => {
      builds += 1
    })
    expect(builds).toBe(2)
    expect(lifecycle.registered("ch-1")).toBe(true)
  })

  test("sweep removes idle containers after the TTL and spares live and non-sweepable ones", async () => {
    const db = makeDb()
    seedEvent(db)
    seedChallenge(db, { id: "ch-live" })
    seedChallenge(db, { id: "ch-idle" })
    // running/idle statuses count as live; "completed" does not.
    seedAgent(db, {
      id: "agent-live",
      challengeId: "ch-live",
      status: "running",
    })
    seedAgent(db, {
      id: "agent-done",
      challengeId: "ch-idle",
      status: "completed",
    })
    const { manager, kills } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager, 5_000)

    await lifecycle.ensureContainer(
      ensureOpts("ch-live", "c-live"),
      async () => {}
    )
    await lifecycle.ensureContainer(
      ensureOpts("ch-idle", "c-idle"),
      async () => {}
    )
    await lifecycle.ensureContainer(
      ensureOpts("orch:evt-1", "c-orch", false),
      async () => {}
    )

    const t0 = Date.now()
    setSystemTime(t0)
    try {
      // First sweep arms idleSince on non-live workspaces, removes nothing.
      lifecycle.sweep()
      expect(lifecycle.registered("ch-idle")).toBe(true)

      // Still within the TTL: the armed container survives.
      setSystemTime(t0 + 4_999)
      lifecycle.sweep()
      expect(lifecycle.registered("ch-idle")).toBe(true)

      // Past the TTL: the idle container is torn down (SIGTERM phase).
      setSystemTime(t0 + 5_001)
      lifecycle.sweep()
      await flush()

      expect(lifecycle.registered("ch-idle")).toBe(false)
      expect(kills).toContainEqual({ name: "c-idle", signal: "SIGTERM" })
      // Live workspace and the scheduler container are never swept.
      expect(lifecycle.registered("ch-live")).toBe(true)
      expect(lifecycle.registered("orch:evt-1")).toBe(true)
      expect(kills.filter((kill) => kill.name !== "c-idle")).toEqual([])
    } finally {
      setSystemTime(t0)
    }
  })

  test("ensure rebuilds when the registered container died", async () => {
    const db = makeDb()
    const { manager, setRunning } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)

    let builds = 0
    const opts = ensureOpts("ch-1", "c-ch-1")
    await lifecycle.ensureContainer(opts, async () => {
      builds += 1
    })
    expect(builds).toBe(1)

    // Probe reports the container is gone; the next ensure rebuilds.
    setRunning("c-ch-1", false)
    expect(await lifecycle.isRunning("ch-1")).toBe(false)
    await lifecycle.ensureContainer(opts, async () => {
      builds += 1
    })
    expect(builds).toBe(2)
    expect(lifecycle.registered("ch-1")).toBe(true)
  })

  test("removeContainer drops the entry, sends SIGTERM and arms the 10s grace", async () => {
    const db = makeDb()
    const { manager, kills } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)
    await lifecycle.ensureContainer(
      ensureOpts("ch-1", "c-ch-1"),
      async () => {}
    )

    const capture = captureTimeouts()
    capture.install()
    try {
      lifecycle.removeContainer("ch-1")
    } finally {
      capture.restore()
    }

    expect(lifecycle.registered("ch-1")).toBe(false)
    expect(await lifecycle.isRunning("ch-1")).toBe(false)
    await flush()
    expect(kills).toEqual([{ name: "c-ch-1", signal: "SIGTERM" }])

    const timer = capture.timers[0]
    expect(timer).toBeDefined()
    expect(timer?.delay).toBe(10_000)

    // Grace expires while the container still runs → forced kill fires.
    timer?.run()
    await flush()
    expect(kills).toContainEqual({ name: "c-ch-1", signal: "SIGKILL" })
  })

  test("force kill is skipped when the container exited within the grace", async () => {
    const db = makeDb()
    const { manager, kills, setRunning } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)
    await lifecycle.ensureContainer(
      ensureOpts("ch-1", "c-ch-1"),
      async () => {}
    )

    const capture = captureTimeouts()
    capture.install()
    try {
      lifecycle.removeContainer("ch-1")
    } finally {
      capture.restore()
    }

    // Container acked the SIGTERM and exited before the grace elapsed.
    setRunning("c-ch-1", false)
    await flush()
    const timer = capture.timers[0]
    expect(timer).toBeDefined()
    timer?.run()
    await flush()

    expect(kills).toEqual([{ name: "c-ch-1", signal: "SIGTERM" }])
  })

  test("activity within the grace window cancels the pending SIGKILL", async () => {
    const db = makeDb()
    const { manager, kills } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)
    await lifecycle.ensureContainer(
      ensureOpts("ch-1", "c-ch-1"),
      async () => {}
    )

    const capture = captureTimeouts()
    capture.install()
    try {
      lifecycle.removeContainer("ch-1")
      const timer = capture.timers[0]
      expect(timer).toBeDefined()

      // A message reopens the workspace: ensure rebuilds and must disarm
      // the pending force-kill for the old container.
      await lifecycle.ensureContainer(
        ensureOpts("ch-1", "c-ch-1"),
        async () => {}
      )
      expect(timer?.cleared).toBe(true)
      expect(lifecycle.registered("ch-1")).toBe(true)
    } finally {
      capture.restore()
    }
    await flush()
    expect(kills).toEqual([{ name: "c-ch-1", signal: "SIGTERM" }])
  })

  test("removeContainer on an unknown key is a no-op", async () => {
    const db = makeDb()
    const { manager, kills } = fakeContainerManager()
    const lifecycle = makeLifecycle(db, manager)

    const capture = captureTimeouts()
    capture.install()
    try {
      lifecycle.removeContainer("nope")
    } finally {
      capture.restore()
    }

    expect(await lifecycle.isRunning("nope")).toBe(false)
    await flush()
    expect(kills).toEqual([])
    expect(capture.timers).toEqual([])
  })

  test("close() cancels the sweep interval and pending force-kill timers", async () => {
    const db = makeDb()
    const { manager, kills } = fakeContainerManager()

    const intervalCapture = captureIntervals()
    intervalCapture.install()
    // Both captures stay installed through close() so the clearTimeout /
    // clearInterval calls land on the fakes; nothing else schedules timers
    // in between (flush() only runs after both are restored).
    const capture = captureTimeouts()
    capture.install()
    let lifecycle: ContainerLifecycle
    try {
      lifecycle = createContainerLifecycle({
        db,
        containerManager: manager,
        sweepIntervalMs: 3_600_000,
      })
      cleanups.push(() => lifecycle.close())
      expect(intervalCapture.intervals).toHaveLength(1)

      await lifecycle.ensureContainer(
        ensureOpts("ch-1", "c-ch-1"),
        async () => {}
      )

      lifecycle.removeContainer("ch-1")
      expect(capture.timers).toHaveLength(1)
      lifecycle.close()
      expect(capture.timers[0]?.cleared).toBe(true)
      expect(intervalCapture.intervals[0]?.cleared).toBe(true)
    } finally {
      capture.restore()
      intervalCapture.restore()
    }

    await flush()
    expect(capture.timers[0]?.fired).toBe(false)
    expect(kills).toEqual([{ name: "c-ch-1", signal: "SIGTERM" }])
  })
})
