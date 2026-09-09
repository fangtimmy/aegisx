import { type EventPlatform, get, LIVE_AGENT_STATUSES } from "@aegisx/shared"
import { and, eq, inArray, lt } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challengeRemote,
  challenges,
  eventPlatforms,
  events,
  platformRequestLog,
} from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import type { createStorage } from "../infrastructure/storage"
import { normalizeHttpBaseUrl } from "../infrastructure/urls"
import { A1CtfAdapter } from "./adapters/a1ctf"
import { CtfdAdapter } from "./adapters/ctfd"
import { DasCtfAdapter } from "./adapters/dasctf"
import { Ret2ShellAdapter } from "./adapters/ret2shell"
import { TsecBenchAdapter } from "./adapters/tsecbench"
import type {
  CtfPlatformAdapter,
  PlatformConfig,
  PlatformRequestError,
  PlatformType,
} from "./core"
import { PlatformActionError, platformError } from "./errors"
import { type FlagAcceptOutcome, createPlatformFlags } from "./flags"
import { createPlatformSync } from "./sync"
import { createPlatformTargets } from "./targets"

function createPlatformAdapter(
  config: PlatformConfig,
  onCredential?: (credential: string) => void,
  onError?: (info: PlatformRequestError) => void,
  timeoutMs?: number
): CtfPlatformAdapter {
  if (config.type === "ctfd") return new CtfdAdapter(config, onError, timeoutMs)
  if (config.type === "ret2shell") {
    return new Ret2ShellAdapter(config, onCredential, onError, timeoutMs)
  }
  if (config.type === "tsecbench")
    return new TsecBenchAdapter(config, onError, timeoutMs)
  if (config.type === "dasctf")
    return new DasCtfAdapter(config, onError, timeoutMs)
  return new A1CtfAdapter(config, onError, timeoutMs)
}

type Storage = ReturnType<typeof createStorage>

/** Request headers persisted verbatim would leak credentials into the audit
 * log — these keys keep their name but store a fixed placeholder. */
const REDACTED_HEADER_KEYS = new Set([
  "authorization",
  "cookie",
  "x-agent-accesskey",
  "benchmark-token",
])
const REDACTED = "[redacted]"
/** Per-body storage cap (characters) for logged request/response bodies. */
const LOG_BODY_CAP = 8_000
/** Retention window for the request log. */
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function redactHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      REDACTED_HEADER_KEYS.has(key.toLowerCase()) ? REDACTED : value,
    ])
  )
}

export function clipBody(body: string | null) {
  return body === null ? null : body.slice(0, LOG_BODY_CAP)
}

export function createPlatformService(
  db: Database,
  storage: Storage,
  maxAttachmentBytes: () => number,
  configStore: ConfigStore
) {
  // Retention sweep: drop log rows older than the window (ISO strings
  // compare lexicographically).
  db.delete(platformRequestLog)
    .where(
      lt(
        platformRequestLog.createdAt,
        new Date(Date.now() - LOG_RETENTION_MS).toISOString()
      )
    )
    .run()

  let onAgentFlagAccepted:
    | ((
        challengeId: string,
        agentId?: string,
        outcome?: FlagAcceptOutcome
      ) => void)
    | undefined
  let onAgentFlagPartial:
    | ((challengeId: string, message: string | null, agentId?: string) => void)
    | undefined
  const logPlatformRequest = (info: PlatformRequestError) => {
    const now = new Date().toISOString()
    db.insert(platformRequestLog)
      .values({
        id: crypto.randomUUID(),
        createdAt: now,
        method: info.method,
        url: info.url,
        requestHeaders: JSON.stringify(redactHeaders(info.requestHeaders)),
        requestBody: clipBody(info.requestBody),
        status: info.status,
        responseHeaders: info.responseHeaders
          ? JSON.stringify(info.responseHeaders)
          : null,
        responseBody: clipBody(info.responseBody),
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
          type: platform.type,
          baseUrl: platform.baseUrl,
          credential: platform.credential,
          remoteEventId: platform.remoteEventId,
        }
      : undefined
  }

  // Adapters are stateful (TSecBench keeps a short-lived list cache), so each
  // event reuses one instance; the memo is dropped whenever its inputs change
  // — the binding row (bind/detach), a renewed credential, or the timeout.
  const adapters = new Map<
    string,
    { adapter: CtfPlatformAdapter; timeoutMs: number | undefined }
  >()

  function adapterForEvent(eventId: string) {
    const config = configForEvent(eventId)
    if (!config) return undefined
    const timeoutMs = get(
      configStore.getSettings(),
      "runtime.platformRequestTimeoutMs"
    )
    const cached = adapters.get(eventId)
    if (cached && cached.timeoutMs === timeoutMs) return cached.adapter
    const adapter = createPlatformAdapter(
      config,
      (credential) => {
        db.update(eventPlatforms)
          .set({ credential, updatedAt: new Date().toISOString() })
          .where(eq(eventPlatforms.eventId, eventId))
          .run()
        // Renewal ran inside the cached adapter, which still carries the old
        // credential in its headers — drop it so the next call rebuilds.
        adapters.delete(eventId)
      },
      logPlatformRequest,
      timeoutMs
    )
    adapters.set(eventId, { adapter, timeoutMs })
    return adapter
  }

  const platformSync = createPlatformSync(
    db,
    storage,
    maxAttachmentBytes,
    storedPlatform,
    adapterForEvent
  )
  const platformFlags = createPlatformFlags(
    db,
    storedPlatform,
    adapterForEvent,
    {
      onAgentFlagAccepted: (challengeId, agentId, outcome) =>
        onAgentFlagAccepted?.(challengeId, agentId, outcome),
      onAgentFlagPartial: (challengeId, message, agentId) =>
        onAgentFlagPartial?.(challengeId, message, agentId),
    }
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
      type: platform.type,
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
      remoteEventId: syntheticRemoteEventId(input.type) ?? input.remoteEventId,
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
    adapters.delete(eventId)
    return publicPlatform(eventId)
  }

  async function detach(eventId: string) {
    if (!storedEvent(eventId)) {
      throw new PlatformActionError("not_found", "Event not found")
    }
    const platform = storedPlatform(eventId)
    if (!platform) return
    // agents.eventId covers both challenge-bound solvers and the event's
    // orchestrator (challengeId null), which a challenges join would drop.
    const activeAgent = db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.eventId, eventId),
          inArray(agents.status, LIVE_AGENT_STATUSES)
        )
      )
      .get()
    if (activeAgent) {
      throw new PlatformActionError(
        "invalid_state",
        "Stop active agents before removing the platform binding"
      )
    }
    await platformTargets.assertNoActiveTargets(eventId)
    db.transaction((tx) => {
      tx.update(challengeRemote)
        .set({ available: false })
        .where(
          and(
            eq(challengeRemote.eventId, eventId),
            eq(challengeRemote.sourceKey, platform.sourceKey)
          )
        )
        .run()
      tx.delete(eventPlatforms).where(eq(eventPlatforms.eventId, eventId)).run()
    })
    adapters.delete(eventId)
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
          remoteEventId: syntheticRemoteEventId(input.type) ?? "",
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
        remoteEventId: syntheticRemoteEventId(input.type) ?? "",
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
    listRemoteEvents,
    assertNoActiveTargets: platformTargets.assertNoActiveTargets,
    setAgentHooks(hooks: {
      onAgentFlagAccepted?(
        challengeId: string,
        agentId?: string,
        outcome?: FlagAcceptOutcome
      ): void
      onAgentFlagPartial?(
        challengeId: string,
        message: string | null,
        agentId?: string
      ): void
    }) {
      // Bound via a closure: the hook is a method on the caller's object, so
      // storing it detached would lose `this` (oxlint unbound-method).
      onAgentFlagAccepted = (challengeId, agentId, outcome) =>
        hooks.onAgentFlagAccepted?.(challengeId, agentId, outcome)
      onAgentFlagPartial = (challengeId, message, agentId) =>
        hooks.onAgentFlagPartial?.(challengeId, message, agentId)
    },
    addManualFlag: platformFlags.addManualFlag,
    deleteFlag: platformFlags.deleteFlag,
    listFlags: platformFlags.listFlags,
    refreshChallengeRemote: platformSync.refreshChallengeRemote,
    submitFlag: platformFlags.submitFlag,
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

/** Platforms with no real event concept get a fixed synthetic remoteEventId
 * (mirrors ctfd → "site"). TSecBench's token and the DASCTF access key each
 * already identify the single match/task. */
function syntheticRemoteEventId(type: PlatformType): string | null {
  if (type === "ctfd") return "site"
  if (type === "tsecbench") return "task"
  if (type === "dasctf") return "match"
  return null
}
