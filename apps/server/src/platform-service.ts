import { basename } from "node:path"
import { and, desc, eq, inArray } from "drizzle-orm"
import type { createDatabase } from "./db"
import {
  attachments,
  challenges,
  eventPlatforms,
  events,
  runs,
  submissions,
} from "./db/schema"
import {
  type CtfPlatformAdapter,
  createPlatformAdapter,
  type PlatformConfig,
  PlatformError,
  type PlatformType,
  type RemoteAttachment,
  type RemoteChallenge,
  type RemoteChallengeSummary,
  type SubmissionResult,
  type TargetState,
} from "./platform"
import type { createStorage } from "./storage"

type Database = ReturnType<typeof createDatabase>["db"]
type Storage = ReturnType<typeof createStorage>

export class PlatformActionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_bound"
      | "invalid_state"
      | "platform_error",
    message: string
  ) {
    super(message)
  }
}

export function createPlatformService(db: Database, storage: Storage) {
  const storedEvent = (eventId: string) =>
    db.select().from(events).where(eq(events.id, eventId)).get()

  const storedPlatform = (eventId: string) =>
    db
      .select()
      .from(eventPlatforms)
      .where(eq(eventPlatforms.eventId, eventId))
      .get()

  function configForEvent(eventId: string): PlatformConfig | undefined {
    const platform = storedPlatform(eventId)
    return platform
      ? {
          type: platform.type as PlatformType,
          baseUrl: platform.baseUrl,
          credential: platform.credential,
          remoteEventId: platform.remoteEventId,
        }
      : undefined
  }

  function adapterForEvent(eventId: string) {
    const config = configForEvent(eventId)
    if (!config) return undefined
    return createPlatformAdapter(config, (credential) => {
      db.update(eventPlatforms)
        .set({ credential, updatedAt: new Date().toISOString() })
        .where(eq(eventPlatforms.eventId, eventId))
        .run()
    })
  }

  function publicPlatform(eventId: string) {
    const platform = storedPlatform(eventId)
    if (!platform) return null
    const { credential: _, sourceKey: __, ...value } = platform
    return { ...value, credentialConfigured: Boolean(platform.credential) }
  }

  async function syncAttachment(
    eventId: string,
    challengeId: string,
    remote: RemoteAttachment,
    adapter: CtfPlatformAdapter
  ) {
    const existing = db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.challengeId, challengeId),
          eq(attachments.remoteId, remote.id)
        )
      )
      .get()
    const id = existing?.id ?? crypto.randomUUID()
    const storageKey = existing?.storageKey ?? `${eventId}/${challengeId}/${id}`
    const response = await adapter.downloadAttachment(remote)
    if (!response.body) {
      throw new PlatformActionError(
        "platform_error",
        `Attachment ${remote.filename} has no content`
      )
    }
    const metadata = await storage.write(storageKey, response.body)
    const now = new Date().toISOString()
    const values = {
      challengeId,
      originalName: basename(remote.filename) || "attachment",
      storageKey,
      remoteId: remote.id,
      ...metadata,
      createdAt: existing?.createdAt ?? now,
    }
    if (existing) {
      db.update(attachments)
        .set(values)
        .where(eq(attachments.id, existing.id))
        .run()
    } else {
      db.insert(attachments)
        .values({ id, ...values })
        .run()
    }
  }

  async function syncRemoteChallenge(
    eventId: string,
    sourceKey: string,
    remote: RemoteChallenge,
    adapter: CtfPlatformAdapter
  ) {
    const existing = db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.eventId, eventId),
          eq(challenges.remoteSourceKey, sourceKey),
          eq(challenges.remoteId, remote.id)
        )
      )
      .get()
    const id = existing?.id ?? crypto.randomUUID()
    const now = new Date().toISOString()
    const values = {
      eventId,
      name: remote.name,
      description: remote.description || "No challenge description provided.",
      category: remote.category,
      points: remote.points,
      remoteSourceKey: sourceKey,
      remoteId: remote.id,
      remoteAvailable: true,
      remoteSolved: existing?.remoteSolved === true || remote.solved,
      remoteTarget: remote.targetSupported,
      remoteTargetCount: remote.targetCount,
      remoteTargetInfo: JSON.stringify(remote.targets),
      remoteUpdatedAt: now,
      updatedAt: now,
    }
    if (existing) {
      db.update(challenges).set(values).where(eq(challenges.id, id)).run()
    } else {
      db.insert(challenges)
        .values({ id, ...values, createdAt: now })
        .run()
    }

    try {
      for (const attachment of remote.attachments) {
        await syncAttachment(eventId, id, attachment, adapter)
      }
      const liveIds = new Set(
        remote.attachments.map((attachment) => attachment.id)
      )
      const stale = db
        .select()
        .from(attachments)
        .where(eq(attachments.challengeId, id))
        .all()
        .filter(
          (attachment) =>
            attachment.remoteId !== null && !liveIds.has(attachment.remoteId)
        )
      for (const attachment of stale) {
        db.delete(attachments).where(eq(attachments.id, attachment.id)).run()
        storage.remove(attachment.storageKey)
      }
    } catch (error) {
      if (!existing) {
        db.delete(challenges).where(eq(challenges.id, id)).run()
        storage.purge(storage.challengePath(eventId, id))
      }
      throw error
    }
    return { id, created: !existing }
  }

  async function discoverInventory(eventId: string) {
    const platform = storedPlatform(eventId)
    const adapter = adapterForEvent(eventId)
    if (!platform || !adapter) {
      throw new PlatformActionError(
        "not_bound",
        "Event is not connected to a platform"
      )
    }
    let remote: RemoteChallengeSummary[]
    try {
      remote = await adapter.listChallenges()
    } catch (error) {
      throw platformError(error)
    }
    const now = new Date().toISOString()
    db.transaction((tx) => {
      tx.update(challenges)
        .set({ remoteAvailable: false })
        .where(
          and(
            eq(challenges.eventId, eventId),
            eq(challenges.remoteSourceKey, platform.sourceKey)
          )
        )
        .run()
      for (const item of remote) {
        tx.update(challenges)
          .set({
            remoteAvailable: true,
            ...(item.solved ? { remoteSolved: true } : {}),
          })
          .where(
            and(
              eq(challenges.eventId, eventId),
              eq(challenges.remoteSourceKey, platform.sourceKey),
              eq(challenges.remoteId, item.id)
            )
          )
          .run()
      }
      tx.update(eventPlatforms)
        .set({ lastSyncedAt: now, updatedAt: now })
        .where(eq(eventPlatforms.eventId, eventId))
        .run()
    })
    return { adapter, platform, remote, syncedAt: now }
  }

  async function discoverChallenges(eventId: string) {
    const inventory = await discoverInventory(eventId)
    const imported = new Map(
      db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.eventId, eventId),
            eq(challenges.remoteSourceKey, inventory.platform.sourceKey)
          )
        )
        .all()
        .flatMap((challenge) =>
          challenge.remoteId ? [[challenge.remoteId, challenge] as const] : []
        )
    )
    return {
      syncedAt: inventory.syncedAt,
      items: inventory.remote.map((remote) => ({
        ...remote,
        imported: imported.has(remote.id),
        localChallengeId: imported.get(remote.id)?.id ?? null,
      })),
    }
  }

  async function syncChallenges(
    eventId: string,
    remoteIds: string[],
    onResult?: (
      result: {
        remoteId: string
        status: "created" | "updated" | "failed"
        challengeId?: string
        error?: string
      },
      completed: number,
      total: number
    ) => void | Promise<void>
  ) {
    const inventory = await discoverInventory(eventId)
    const available = new Map(inventory.remote.map((item) => [item.id, item]))
    const results: Array<{
      remoteId: string
      status: "created" | "updated" | "failed"
      challengeId?: string
      error?: string
    }> = []
    const ids = [...new Set(remoteIds)]
    for (const remoteId of ids) {
      const summary = available.get(remoteId)
      let result: (typeof results)[number]
      if (!summary) {
        result = {
          remoteId,
          status: "failed",
          error: "Remote challenge is unavailable",
        }
      } else {
        try {
          const remote = await inventory.adapter.getChallenge(remoteId)
          const synced = await syncRemoteChallenge(
            eventId,
            inventory.platform.sourceKey,
            { ...remote, solved: remote.solved || summary.solved },
            inventory.adapter
          )
          result = {
            remoteId,
            challengeId: synced.id,
            status: synced.created ? "created" : "updated",
          }
        } catch (error) {
          result = {
            remoteId,
            status: "failed",
            error: syncFailureMessage(error),
          }
        }
      }
      results.push(result)
      await onResult?.(result, results.length, ids.length)
    }
    return { syncedAt: inventory.syncedAt, results }
  }

  async function bind(
    eventId: string,
    input: {
      type: PlatformType
      baseUrl: string
      credential: string
      remoteEventId: string
    }
  ) {
    if (!storedEvent(eventId)) {
      throw new PlatformActionError("not_found", "Event not found")
    }
    const config: PlatformConfig = {
      type: input.type,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      credential: input.credential,
      remoteEventId: input.type === "ctfd" ? "site" : input.remoteEventId,
    }
    const sourceKey = platformSourceKey(config)
    const eventChallenges = db
      .select()
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    if (
      eventChallenges.some(
        (challenge) =>
          challenge.remoteSourceKey !== null &&
          challenge.remoteSourceKey !== sourceKey
      )
    ) {
      throw new PlatformActionError(
        "invalid_state",
        "This event contains challenges from another source"
      )
    }
    try {
      const remoteEvents = await createPlatformAdapter(config, (credential) => {
        config.credential = credential
      }).listEvents()
      if (!remoteEvents.some((remote) => remote.id === config.remoteEventId)) {
        throw new PlatformActionError("not_found", "Remote event not found")
      }
    } catch (error) {
      throw platformError(error)
    }
    const existing = storedPlatform(eventId)
    const now = new Date().toISOString()
    const values = {
      eventId,
      type: config.type,
      baseUrl: config.baseUrl,
      credential: config.credential,
      remoteEventId: config.remoteEventId,
      sourceKey,
      lastSyncedAt:
        existing?.sourceKey === sourceKey ? existing.lastSyncedAt : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existing) {
      db.update(eventPlatforms)
        .set(values)
        .where(eq(eventPlatforms.eventId, eventId))
        .run()
    } else {
      db.insert(eventPlatforms).values(values).run()
    }
    return publicPlatform(eventId)
  }

  function detach(eventId: string) {
    if (!storedEvent(eventId)) {
      throw new PlatformActionError("not_found", "Event not found")
    }
    const platform = storedPlatform(eventId)
    if (!platform) return
    db.transaction((tx) => {
      tx.update(challenges)
        .set({ remoteAvailable: false })
        .where(
          and(
            eq(challenges.eventId, eventId),
            eq(challenges.remoteSourceKey, platform.sourceKey)
          )
        )
        .run()
      tx.delete(eventPlatforms).where(eq(eventPlatforms.eventId, eventId)).run()
    })
  }

  async function listRemoteEvents(input: {
    type: PlatformType
    baseUrl: string
    credential: string
  }) {
    try {
      return await createPlatformAdapter({
        ...input,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        remoteEventId: input.type === "ctfd" ? "site" : "",
      }).listEvents()
    } catch (error) {
      throw platformError(error)
    }
  }

  async function submitFlag(runId: string, challengeId: string, flag?: string) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    const platform = challenge ? storedPlatform(challenge.eventId) : undefined
    if (
      !challenge?.remoteId ||
      !challenge.remoteAvailable ||
      !platform ||
      challenge.remoteSourceKey !== platform.sourceKey
    ) {
      return undefined
    }
    if (!flag?.trim()) {
      throw new PlatformActionError(
        "invalid_state",
        "A flag is required for a platform challenge"
      )
    }
    const adapter = adapterForEvent(challenge.eventId) as CtfPlatformAdapter
    const value = flag.trim()
    let submission = db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.runId, runId),
          eq(submissions.challengeId, challengeId),
          eq(submissions.flag, value)
        )
      )
      .orderBy(desc(submissions.updatedAt))
      .get()
    if (
      submission &&
      ["accepted", "already_solved", "rejected", "partial"].includes(
        submission.status
      )
    ) {
      return storedSubmissionResult(submission)
    }
    const now = new Date().toISOString()
    if (!submission) {
      submission = {
        id: crypto.randomUUID(),
        runId,
        challengeId,
        flag: value,
        status: "pending",
        remoteId: null,
        message: null,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(submissions).values(submission).run()
    }
    const persist = (result: SubmissionResult) => {
      db.update(submissions)
        .set({
          status: result.status,
          remoteId: result.remoteId ?? submission.remoteId,
          message: result.message ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(submissions.id, submission.id))
        .run()
    }
    try {
      let result =
        submission.status === "pending" &&
        submission.remoteId &&
        adapter.getSubmission
          ? await adapter.getSubmission(challenge.remoteId, submission.remoteId)
          : await adapter.submitFlag(challenge.remoteId, value)
      persist(result)
      for (
        let attempt = 0;
        result.status === "pending" && attempt < 60;
        attempt += 1
      ) {
        if (!result.remoteId || !adapter.getSubmission) break
        await Bun.sleep(1000)
        result = await adapter.getSubmission(
          challenge.remoteId,
          result.remoteId
        )
        persist(result)
      }
      if (result.status === "accepted" || result.status === "already_solved") {
        db.transaction((tx) => {
          tx.update(challenges)
            .set({ remoteSolved: true, updatedAt: new Date().toISOString() })
            .where(eq(challenges.id, challengeId))
            .run()
          tx.update(runs).set({ flag: value }).where(eq(runs.id, runId)).run()
        })
      }
      return result
    } catch (error) {
      persist({ status: "error", message: submissionErrorMessage(error) })
      throw platformError(error)
    }
  }

  function canFinishRun(runId: string, challengeId: string) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (
      !challenge?.remoteId ||
      !challenge.remoteAvailable ||
      challenge.remoteSolved
    ) {
      return true
    }
    return Boolean(
      db
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.runId, runId),
            eq(submissions.challengeId, challengeId),
            inArray(submissions.status, ["accepted", "already_solved"])
          )
        )
        .get()
    )
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
    if (["starting", "running", "stopping"].includes(target.status)) {
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

  return {
    bind,
    canFinishRun,
    detach,
    discoverChallenges,
    getPublic: publicPlatform,
    ignoreTarget,
    isBoundEvent: (eventId: string) => Boolean(storedPlatform(eventId)),
    listRemoteEvents,
    submitFlag,
    syncChallenges,
    targetAction,
  }
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

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PlatformActionError(
      "invalid_state",
      "Platform URL must use HTTP or HTTPS"
    )
  }
  return url.toString().replace(/\/$/, "")
}

function platformSourceKey(config: PlatformConfig) {
  return JSON.stringify([
    config.type,
    normalizeBaseUrl(config.baseUrl),
    config.remoteEventId,
  ])
}

function platformError(error: unknown): PlatformActionError {
  if (error instanceof PlatformActionError) return error
  if (error instanceof PlatformError) {
    return new PlatformActionError("platform_error", error.message)
  }
  return new PlatformActionError("platform_error", "Platform request failed")
}

function syncFailureMessage(error: unknown) {
  return error instanceof PlatformActionError || error instanceof PlatformError
    ? platformError(error).message
    : "Challenge could not be stored"
}

function storedSubmissionResult(
  submission: typeof submissions.$inferSelect
): SubmissionResult {
  return {
    status: submission.status as SubmissionResult["status"],
    ...(submission.remoteId ? { remoteId: submission.remoteId } : {}),
    ...(submission.message ? { message: submission.message } : {}),
  }
}

function submissionErrorMessage(error: unknown) {
  return error instanceof PlatformActionError || error instanceof PlatformError
    ? error.message
    : "Platform request failed"
}
