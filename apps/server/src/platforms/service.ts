import { and, eq, inArray } from "drizzle-orm"
import { type EventPlatform, get } from "../../../shared"
import type { createDatabase } from "../db"
import {
  challengeRemote,
  challenges,
  eventPlatforms,
  events,
  platformRequestLog,
  runs,
} from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import type { createStorage } from "../infrastructure/storage"
import { normalizeHttpBaseUrl } from "../infrastructure/urls"
import { A1CtfAdapter } from "./adapters/a1ctf"
import { CtfdAdapter } from "./adapters/ctfd"
import { Ret2ShellAdapter } from "./adapters/ret2shell"
import type {
  CtfPlatformAdapter,
  PlatformConfig,
  PlatformRequestError,
  PlatformType,
} from "./core"
import { PlatformActionError, platformError } from "./errors"
import { createPlatformSubmissions } from "./submissions"
import { createPlatformSync } from "./sync"
import { createPlatformTargets } from "./targets"

export { PlatformActionError } from "./errors"

export function createPlatformAdapter(
  config: PlatformConfig,
  onCredential?: (credential: string) => void,
  onError?: (info: PlatformRequestError) => void,
  timeoutMs?: number
): CtfPlatformAdapter {
  if (config.type === "ctfd") return new CtfdAdapter(config, onError, timeoutMs)
  if (config.type === "ret2shell") {
    return new Ret2ShellAdapter(config, onCredential, onError, timeoutMs)
  }
  return new A1CtfAdapter(config, onError, timeoutMs)
}

type Database = ReturnType<typeof createDatabase>["db"]
type Storage = ReturnType<typeof createStorage>

export function createPlatformService(
  db: Database,
  storage: Storage,
  maxAttachmentBytes: () => number,
  configStore: ConfigStore
) {
  let onRunFlagAccepted: ((runId: string) => void) | undefined
  const logPlatformRequest = (info: PlatformRequestError) => {
    const now = new Date().toISOString()
    db.insert(platformRequestLog)
      .values({
        id: crypto.randomUUID(),
        createdAt: now,
        method: info.method,
        url: info.url,
        requestHeaders: JSON.stringify(info.requestHeaders),
        requestBody: info.requestBody,
        status: info.status,
        responseHeaders: info.responseHeaders
          ? JSON.stringify(info.responseHeaders)
          : null,
        responseBody: info.responseBody,
        error: info.error,
      })
      .run()
    console.error("Platform request failed", {
      method: info.method,
      url: info.url,
      status: info.status,
      error: info.error,
    })
  }

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
    return createPlatformAdapter(
      config,
      (credential) => {
        db.update(eventPlatforms)
          .set({ credential, updatedAt: new Date().toISOString() })
          .where(eq(eventPlatforms.eventId, eventId))
          .run()
      },
      logPlatformRequest,
      get(configStore.getSettings(), "runtime.platformRequestTimeoutMs")
    )
  }

  const platformSync = createPlatformSync(
    db,
    storage,
    maxAttachmentBytes,
    storedPlatform,
    adapterForEvent
  )
  const platformSubmissions = createPlatformSubmissions(
    db,
    storedPlatform,
    adapterForEvent,
    { onRunFlagAccepted: (runId) => onRunFlagAccepted?.(runId) }
  )
  const platformTargets = createPlatformTargets(
    db,
    storedPlatform,
    adapterForEvent
  )

  function publicPlatform(eventId: string): EventPlatform | null {
    const platform = storedPlatform(eventId)
    if (!platform) return null
    const { sourceKey: _, ...value } = platform
    return {
      ...value,
      type: platform.type as EventPlatform["type"],
      credentialConfigured: Boolean(platform.credential),
    }
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
    const linkedSources = db
      .select({ sourceKey: challengeRemote.sourceKey })
      .from(challengeRemote)
      .innerJoin(challenges, eq(challengeRemote.challengeId, challenges.id))
      .where(eq(challenges.eventId, eventId))
      .all()
      .map((row) => row.sourceKey)
    if (linkedSources.some((value) => value !== sourceKey)) {
      throw new PlatformActionError(
        "invalid_state",
        "This event contains challenges from another source"
      )
    }
    try {
      const remoteEvents = await createPlatformAdapter(
        config,
        (credential) => {
          config.credential = credential
        },
        logPlatformRequest,
        get(configStore.getSettings(), "runtime.platformRequestTimeoutMs")
      ).listEvents()
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

  async function detach(eventId: string) {
    if (!storedEvent(eventId)) {
      throw new PlatformActionError("not_found", "Event not found")
    }
    const platform = storedPlatform(eventId)
    if (!platform) return
    const activeRun = db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(challenges, eq(runs.challengeId, challenges.id))
      .where(
        and(eq(challenges.eventId, eventId), inArray(runs.status, ["running"]))
      )
      .get()
    if (activeRun) {
      throw new PlatformActionError(
        "invalid_state",
        "Stop active runs before removing the platform binding"
      )
    }
    await platformTargets.assertNoActiveTargets(eventId)
    db.transaction((tx) => {
      tx.update(challengeRemote)
        .set({ available: false })
        .where(eq(challengeRemote.sourceKey, platform.sourceKey))
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
      return await createPlatformAdapter(
        {
          ...input,
          baseUrl: normalizeBaseUrl(input.baseUrl),
          remoteEventId: input.type === "ctfd" ? "site" : "",
        },
        undefined,
        logPlatformRequest,
        get(configStore.getSettings(), "runtime.platformRequestTimeoutMs")
      ).listEvents()
    } catch (error) {
      throw platformError(error)
    }
  }

  async function testConnection(input: {
    type: PlatformType
    baseUrl: string
    credential: string
  }) {
    try {
      const config: PlatformConfig = {
        ...input,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        remoteEventId: input.type === "ctfd" ? "site" : "",
      }
      await createPlatformAdapter(
        config,
        (credential) => {
          config.credential = credential
        },
        logPlatformRequest,
        get(configStore.getSettings(), "runtime.platformRequestTimeoutMs")
      ).testConnection()
      return {
        credential:
          config.credential === input.credential ? null : config.credential,
      }
    } catch (error) {
      throw platformError(error)
    }
  }

  async function testBoundConnection(eventId: string) {
    const adapter = adapterForEvent(eventId)
    if (!adapter) {
      throw new PlatformActionError("not_bound", "Platform is not connected")
    }
    try {
      await adapter.testConnection()
    } catch (error) {
      throw platformError(error)
    }
  }

  return {
    bind,
    detach,
    discoverChallenges: platformSync.discoverChallenges,
    getPublic: publicPlatform,
    ignoreTarget: platformTargets.ignoreTarget,
    isBoundEvent: (eventId: string) => Boolean(storedPlatform(eventId)),
    listRemoteEvents,
    assertNoActiveTargets: platformTargets.assertNoActiveTargets,
    setRunHooks(hooks: { onRunFlagAccepted?(runId: string): void }) {
      onRunFlagAccepted = hooks.onRunFlagAccepted
    },
    submitFlag: platformSubmissions.submitFlag,
    syncChallenges: platformSync.syncChallenges,
    targetAction: platformTargets.targetAction,
    testBoundConnection,
    testConnection,
  }
}

function normalizeBaseUrl(value: string) {
  try {
    return normalizeHttpBaseUrl(value)
  } catch {
    throw new PlatformActionError(
      "invalid_state",
      "Platform URL must use HTTP or HTTPS"
    )
  }
}

function platformSourceKey(config: PlatformConfig) {
  return JSON.stringify([
    config.type,
    normalizeBaseUrl(config.baseUrl),
    config.remoteEventId,
  ])
}
