import { and, eq } from "drizzle-orm"
import type { createDatabase } from "../db"
import { challenges, type eventPlatforms } from "../db/schema"
import {
  type CtfPlatformAdapter,
  isActiveTarget,
  type TargetState,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredPlatform = typeof eventPlatforms.$inferSelect

export function createPlatformTargets(
  db: Database,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined
) {
  async function assertNoActiveTargets(eventId: string) {
    const platform = storedPlatform(eventId)
    const adapter = adapterForEvent(eventId)
    if (!platform || !adapter?.getTarget) return
    const targets = db
      .select({ remoteId: challenges.remoteId })
      .from(challenges)
      .where(
        and(
          eq(challenges.eventId, eventId),
          eq(challenges.remoteTarget, true),
          eq(challenges.remoteAvailable, true),
          eq(challenges.remoteTargetIgnored, false)
        )
      )
      .all()
    for (const target of targets) {
      if (!target.remoteId) continue
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
    action: "get" | "start" | "extend" | "stop"
  ) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    const platform = challenge ? storedPlatform(challenge.eventId) : undefined
    if (
      !challenge?.remoteId ||
      !challenge.remoteAvailable ||
      challenge.remoteTargetIgnored ||
      !platform ||
      challenge.remoteSourceKey !== platform.sourceKey
    ) {
      throw new PlatformActionError(
        "not_bound",
        "Challenge is not managed by the connected platform"
      )
    }
    const adapter = adapterForEvent(challenge.eventId)
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
      const target = await method.call(adapter, challenge.remoteId)
      return action === "start"
        ? await waitForTarget(adapter, challenge.remoteId, target)
        : target
    } catch (error) {
      throw platformError(error)
    }
  }

  async function ignoreTarget(challengeId: string) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    const platform = challenge ? storedPlatform(challenge.eventId) : undefined
    if (
      !challenge?.remoteId ||
      !challenge.remoteAvailable ||
      !challenge.remoteTarget ||
      !platform ||
      challenge.remoteSourceKey !== platform.sourceKey
    ) {
      throw new PlatformActionError(
        "not_bound",
        "Challenge has no platform target"
      )
    }
    if (challenge.remoteTargetIgnored) return
    const adapter = adapterForEvent(challenge.eventId)
    if (!adapter?.getTarget) {
      throw new PlatformActionError(
        "invalid_state",
        "Platform does not support target management"
      )
    }
    let target: TargetState
    try {
      target = await adapter.getTarget(challenge.remoteId)
    } catch (error) {
      throw platformError(error)
    }
    if (isActiveTarget(target)) {
      throw new PlatformActionError(
        "invalid_state",
        "Stop the remote target before removing it from AegisX"
      )
    }
    db.update(challenges)
      .set({ remoteTargetIgnored: true, updatedAt: new Date().toISOString() })
      .where(eq(challenges.id, challengeId))
      .run()
  }

  return { assertNoActiveTargets, ignoreTarget, targetAction }
}

async function waitForTarget(
  adapter: CtfPlatformAdapter,
  remoteId: string,
  initial: TargetState
) {
  let target = initial
  for (
    let attempt = 0;
    target.status === "starting" && attempt < 60;
    attempt += 1
  ) {
    await Bun.sleep(1000)
    target = (await adapter.getTarget?.(remoteId)) ?? target
  }
  if (target.status !== "running") {
    throw new PlatformActionError(
      "platform_error",
      target.message ?? "Challenge target did not become ready"
    )
  }
  return target
}
