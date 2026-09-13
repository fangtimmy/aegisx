import type { EventTargetRow } from "@aegisx/shared"
import { and, eq } from "drizzle-orm"

import type { Database } from "../db"
import { challengeRemote, challenges, type eventPlatforms } from "../db/schema"
import { type Clock, systemClock } from "../run/clock"
import { emitDomainEvent } from "../run/domain-events/store"
import { getChallengeRemote, isTargetCapable } from "./challenge-state"
import {
  type CtfPlatformAdapter,
  isActiveTarget,
  type TargetState,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

type StoredPlatform = typeof eventPlatforms.$inferSelect

/** Polling cadence while a target transitions starting → running. */
const TARGET_READY_POLL_INTERVAL_MS = 1000
const TARGET_READY_POLL_MAX_ATTEMPTS = 60

/** Concurrent platform calls for event-wide target scans. Each row is one
 * adapter round-trip; a small pool keeps a 50-challenge event responsive
 * without hammering the platform. */
const TARGET_SCAN_CONCURRENCY = 5

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

export function createPlatformTargets(
  db: Database,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined,
  options?: {
    /** Time source for the starting → running poll
     * (`TARGET_READY_POLL_INTERVAL_MS`). Defaults to the system clock; tests
     * inject a fake clock. */
    clock?: Clock
  }
) {
  const clock = options?.clock ?? systemClock
  function platformForChallenge(challengeId: string) {
    const challenge = db
      .select({ eventId: challenges.eventId })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    return challenge ? storedPlatform(challenge.eventId) : undefined
  }

  async function assertNoActiveTargets(eventId: string) {
    const platform = storedPlatform(eventId)
    const adapter = adapterForEvent(eventId)
    if (!platform || !adapter?.getTarget) return
    const rows = db
      .select()
      .from(challengeRemote)
      .where(
        and(
          eq(challengeRemote.eventId, eventId),
          eq(challengeRemote.sourceKey, platform.sourceKey)
        )
      )
      .all()
      .filter(isTargetCapable)
    for (const target of rows) {
      let state: TargetState
      try {
        state = await adapter.getTarget(target.remoteId)
      } catch (error) {
        throw platformError(error)
      }
      if (isActiveTarget(state)) {
        throw new PlatformActionError(
          "invalid_state",
          "Stop all remote targets before removing the platform binding"
        )
      }
    }
  }

  async function targetAction(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop",
    signal?: AbortSignal
  ) {
    const platform = platformForChallenge(challengeId)
    const remote = getChallengeRemote(db, challengeId)
    if (
      !isTargetCapable(remote) ||
      !platform ||
      remote.sourceKey !== platform.sourceKey
    ) {
      throw new PlatformActionError(
        "not_bound",
        "Challenge is not managed by the connected platform"
      )
    }
    const adapter = adapterForEvent(platform.eventId)
    if (!adapter) {
      throw new PlatformActionError(
        "not_bound",
        "Event is not connected to a platform"
      )
    }
    // Reference through bound methods: adapter methods are plain functions,
    // so passing them detached would lose `this` (oxlint unbound-method).
    const method =
      action === "get"
        ? adapter.getTarget?.bind(adapter)
        : action === "start"
          ? adapter.startTarget?.bind(adapter)
          : action === "extend"
            ? adapter.extendTarget?.bind(adapter)
            : adapter.stopTarget?.bind(adapter)
    if (!method) {
      throw new PlatformActionError(
        "invalid_state",
        "Platform does not support target management"
      )
    }
    try {
      const target = await method.call(adapter, remote.remoteId, signal)
      return action === "start"
        ? await waitForTarget(adapter, clock, remote.remoteId, target, signal)
        : target
    } catch (error) {
      throw platformError(error)
    }
  }

  async function ignoreTarget(challengeId: string) {
    const platform = platformForChallenge(challengeId)
    const remote = getChallengeRemote(db, challengeId)
    if (
      !remote?.available ||
      !remote?.targetSupported ||
      !platform ||
      remote.sourceKey !== platform.sourceKey
    ) {
      throw new PlatformActionError(
        "not_bound",
        "Challenge has no platform target"
      )
    }
    if (remote.targetIgnored) return
    const adapter = adapterForEvent(platform.eventId)
    if (!adapter?.getTarget) {
      throw new PlatformActionError(
        "invalid_state",
        "Platform does not support target management"
      )
    }
    let target: TargetState
    try {
      target = await adapter.getTarget(remote.remoteId)
    } catch (error) {
      throw platformError(error)
    }
    if (isActiveTarget(target)) {
      throw new PlatformActionError(
        "invalid_state",
        "Stop the remote target before removing it from AegisX"
      )
    }
    // The operator override rides the challenge.overridden fact — the
    // projector owns the challenge_remote mirror (no syncedAt bump: this is
    // an operator edit, not a platform sync).
    emitDomainEvent(db, {
      type: "challenge.overridden",
      eventId: remote.eventId,
      challengeId,
      actor: { kind: "user" },
      payload: { targetIgnored: true },
    })
  }

  /** Every target-capable, non-ignored challenge of the event. */
  function eventTargetChallenges(eventId: string) {
    return db
      .select({ id: challenges.id, name: challenges.name })
      .from(challenges)
      .innerJoin(
        challengeRemote,
        eq(challengeRemote.challengeId, challenges.id)
      )
      .where(
        and(
          eq(challenges.eventId, eventId),
          eq(challengeRemote.available, true),
          eq(challengeRemote.targetSupported, true),
          eq(challengeRemote.targetIgnored, false)
        )
      )
      .all()
  }

  /** Event-wide target snapshot: one live adapter get per target-capable
   * challenge. Per-row failures degrade to an error row — a single stale
   * challenge must not blank the whole view. */
  async function listEventTargets(eventId: string): Promise<EventTargetRow[]> {
    return mapPool(
      eventTargetChallenges(eventId),
      TARGET_SCAN_CONCURRENCY,
      async (row) => {
        try {
          const target = await targetAction(row.id, "get")
          return {
            challengeId: row.id,
            name: row.name,
            ok: true as const,
            status: target.status,
            endpoints: target.endpoints,
            expiresAt: target.expiresAt,
            message: target.message ?? null,
          }
        } catch (error) {
          return {
            challengeId: row.id,
            name: row.name,
            ok: false as const,
            error: errorText(error),
          }
        }
      }
    )
  }

  /** Stop every active target of the event (get → stop-if-active, so absent
   * targets cost nothing and don't report failures). Best-effort per row. */
  async function stopEventTargets(eventId: string): Promise<{
    stopped: number
    failures: Array<{ challengeId: string; name: string; error: string }>
  }> {
    let stopped = 0
    const failures: Array<{
      challengeId: string
      name: string
      error: string
    }> = []
    await mapPool(
      eventTargetChallenges(eventId),
      TARGET_SCAN_CONCURRENCY,
      async (row) => {
        try {
          const target = await targetAction(row.id, "get")
          if (!isActiveTarget(target)) return
          await targetAction(row.id, "stop")
          stopped += 1
        } catch (error) {
          failures.push({
            challengeId: row.id,
            name: row.name,
            error: errorText(error),
          })
        }
      }
    )
    return { stopped, failures }
  }

  return {
    assertNoActiveTargets,
    ignoreTarget,
    targetAction,
    listEventTargets,
    stopEventTargets,
  }
}

async function waitForTarget(
  adapter: CtfPlatformAdapter,
  clock: Clock,
  remoteId: string,
  initial: TargetState,
  signal?: AbortSignal
) {
  let target = initial
  for (
    let attempt = 0;
    target.status === "starting" && attempt < TARGET_READY_POLL_MAX_ATTEMPTS;
    attempt += 1
  ) {
    await clock.sleep(TARGET_READY_POLL_INTERVAL_MS, signal)
    target = (await adapter.getTarget?.(remoteId, signal)) ?? target
  }
  if (target.status !== "running") {
    throw new PlatformActionError(
      "platform_error",
      target.message ?? "Challenge target did not become ready"
    )
  }
  return target
}
