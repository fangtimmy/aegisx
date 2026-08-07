import { setTimeout as sleep } from "node:timers/promises"

import { eq } from "drizzle-orm"

import type { createDatabase } from "../db"
import { challengeRemote, challenges, type eventPlatforms } from "../db/schema"
import { getChallengeRemote, isTargetCapable } from "./challenge-state"
import {
  type CtfPlatformAdapter,
  isActiveTarget,
  type TargetState,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredPlatform = typeof eventPlatforms.$inferSelect

/** Polling cadence while a target transitions starting → running. */
const TARGET_READY_POLL_INTERVAL_MS = 1000
const TARGET_READY_POLL_MAX_ATTEMPTS = 60

export function createPlatformTargets(
  db: Database,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined
) {
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
      .where(eq(challengeRemote.sourceKey, platform.sourceKey))
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
    const method =
      action === "get"
        ? adapter.getTarget
        : action === "start"
          ? adapter.startTarget
          : action === "extend"
            ? adapter.extendTarget
            : adapter.stopTarget
    if (!method) {
      throw new PlatformActionError(
        "invalid_state",
        "Platform does not support target management"
      )
    }
    try {
      const target = await method.call(adapter, remote.remoteId, signal)
      return action === "start"
        ? await waitForTarget(adapter, remote.remoteId, target, signal)
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
    db.update(challengeRemote)
      .set({ targetIgnored: true })
      .where(eq(challengeRemote.challengeId, challengeId))
      .run()
  }

  return { assertNoActiveTargets, ignoreTarget, targetAction }
}

async function waitForTarget(
  adapter: CtfPlatformAdapter,
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
    await sleep(TARGET_READY_POLL_INTERVAL_MS, undefined, { signal })
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
