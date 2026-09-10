import { LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, inArray, isNotNull } from "drizzle-orm"

import type { Database } from "../db"
import { agents } from "../db/schema"
import type { Clock, ClockTimer } from "./clock"
import { createTimerHub, systemClock } from "./clock"
import type { ContainerManager } from "./container/container-manager"

/** Idle-sweep cadence for challenge containers. */
const SWEEP_INTERVAL_MS = 60_000
/** A challenge container with no live agent for this long is removed. */
const CONTAINER_IDLE_TTL_MS = 10 * 60_000
/** Grace between SIGTERM and a forced SIGKILL on container teardown. */
const FORCE_KILL_GRACE_MS = 10_000

export type EnsureContainerOptions = {
  containerName: string
  /** Registry key (challengeId / `orch:<eventId>`). */
  key: string
  /** Solver workspaces participate in the idle TTL sweep; the scheduler
   * container is managed by the scheduler agent's lifecycle and never
   * swept. */
  sweepable: boolean
}

export type WorkspaceContainerState = {
  name: string
  sweepable: boolean
  /** When the sweep last saw no live agent on this workspace (null while
   * live). Armed by the sweep; reset by any live-agent observation. */
  idleSince: number | null
}

export type ContainerLifecycleDeps = {
  db: Database
  containerManager: ContainerManager
  /** Test seam: sweep cadence + idle TTL. */
  sweepIntervalMs?: number
  idleTtlMs?: number
  /** Time layer (default: the system clock); drives the sweep interval, the
   * SIGKILL grace timers and the idle clock. */
  clock?: Clock
}

export type ContainerLifecycle = ReturnType<typeof createContainerLifecycle>

/**
 * v19 container lifecycle:
 * challenge containers are lazily created on first spawn and reclaimed once
 * the challenge has had no live agent for 10 minutes; the scheduler
 * container is created/removed by the scheduler agent's lifecycle
 * (start/close/reset) and is never swept. The container is a shared
 * resource — no agent action ever kills it; only the sweep (or explicit
 * removal) does.
 */
export function createContainerLifecycle(deps: ContainerLifecycleDeps) {
  const { db, containerManager } = deps
  const sweepIntervalMs = deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS
  const idleTtlMs = deps.idleTtlMs ?? CONTAINER_IDLE_TTL_MS
  const clock = deps.clock ?? systemClock
  const hub = createTimerHub(clock)
  const registry = new Map<string, WorkspaceContainerState>()
  /** In-flight ensure builds per key (single-flight: a concurrent ensure
   * waits for the first build instead of racing a second one). */
  const building = new Map<string, Promise<void>>()
  /** SIGTERM→SIGKILL grace timer per container key (hub-registered). */
  const forceKillTimers = new Map<string, ClockTimer>()
  let sweepTimer: ClockTimer | null = null

  function registered(key: string): boolean {
    return registry.has(key)
  }

  async function isRunning(key: string): Promise<boolean> {
    const state = registry.get(key)
    if (!state) return false
    return containerManager.isRunning(state.name)
  }

  /** Get (or lazily create) the container for a workspace. Reuses a running
   * registered container; otherwise builds a fresh one (slow I/O — call
   * outside fence/agent locks). Single-flighted per key so concurrent
   * restores of agents on the same workspace share one build. */
  async function ensureContainer(
    opts: EnsureContainerOptions,
    build: () => Promise<void>
  ): Promise<void> {
    const existing = registry.get(opts.key)
    if (existing) {
      const live = await containerManager
        .isRunning(existing.name)
        .catch(() => false)
      if (live) return
    }
    const inFlight = building.get(opts.key)
    if (inFlight) return inFlight
    const pending = (async () => {
      clearForceKill(opts.key)
      await build()
      registry.set(opts.key, {
        name: opts.containerName,
        sweepable: opts.sweepable,
        idleSince: null,
      })
    })().finally(() => {
      if (building.get(opts.key) === pending) building.delete(opts.key)
    })
    building.set(opts.key, pending)
    return pending
  }

  function clearForceKill(key: string): void {
    const timer = forceKillTimers.get(key)
    if (timer) {
      hub.clear(timer)
      forceKillTimers.delete(key)
    }
  }

  /** Remove a workspace container: SIGTERM, then SIGKILL after the grace.
   * Drops the registry entry immediately (a fresh ensure rebuilds on
   * demand; the workspace files on the host are untouched). */
  function removeContainer(key: string): void {
    const state = registry.get(key)
    registry.delete(key)
    clearForceKill(key)
    if (!state) return
    void containerManager.kill(state.name, "SIGTERM").catch(() => undefined)
    const timer = hub.setTimeout(() => {
      forceKillTimers.delete(key)
      void containerManager
        .isRunning(state.name)
        .then((running) =>
          running
            ? containerManager
                .kill(state.name, "SIGKILL")
                .catch(() => undefined)
            : undefined
        )
        .catch(() => undefined)
    }, FORCE_KILL_GRACE_MS)
    forceKillTimers.set(key, timer)
  }

  /** Boot recovery: no registry survives a crash — the process memory is
   * gone. Live agents flip to idle (their files persist; a message reopens
   * them and rebuilds the container on demand). Any orphan container still
   * known to the daemon under our naming scheme cannot be enumerated
   * reliably, so recovery only resets DB state; the sweep + create's
   * remove-first semantics handle strays. */
  function liveSolverChallengeIds(): Set<string> {
    const rows = db
      .select({ challengeId: agents.challengeId })
      .from(agents)
      .where(
        and(
          isNotNull(agents.challengeId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .all()
    return new Set(
      rows.flatMap((row) => (row.challengeId ? [row.challengeId] : []))
    )
  }

  function sweep(): void {
    try {
      const live = liveSolverChallengeIds()
      const now = clock.now()
      for (const [key, state] of registry) {
        if (!state.sweepable) continue
        if (live.has(key)) {
          state.idleSince = null
          continue
        }
        if (state.idleSince === null) {
          state.idleSince = now
          continue
        }
        if (now - state.idleSince >= idleTtlMs) removeContainer(key)
      }
    } catch (error) {
      console.error("container idle sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function start(): void {
    if (sweepTimer) return
    sweepTimer = hub.setInterval(() => sweep(), sweepIntervalMs)
  }

  function close(): void {
    // The sweep interval + every pending SIGKILL grace timer, one call.
    hub.disposeAll()
    sweepTimer = null
    forceKillTimers.clear()
  }

  start()

  return {
    registered,
    isRunning,
    ensureContainer,
    removeContainer,
    sweep,
    close,
  }
}
