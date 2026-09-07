import {
  isActiveAgentStatus,
  modelAddress,
  type PlatformType,
  type ProviderType,
} from "@aegisx/shared"
import { eq } from "drizzle-orm"

import type { Database } from "./db"
import {
  challenges,
  events,
  eventPlatforms,
  schedulerConfig,
} from "./db/schema"
import type { ConfigStore, ProviderData } from "./infrastructure/config-store"
import type { createPlatformService } from "./platforms/service"
import { builtinModelProfiles } from "./providers/builtin-models"
import type { AgentService } from "./run/service"

/**
 * Appliance bootstrap (AEGISX_BOOTSTRAP=1): turn env vars into a fully
 * configured instance — LLM provider + default model, event + platform
 * binding, challenge sync, a running scheduler. Idempotent: existing
 * resources are matched and only rewritten when env drift is detected, so a
 * container restart on a persistent data dir converges without duplicating
 * anything. Failures log and leave the server up (the UI stays usable for
 * manual repair).
 */

/** Conservative metadata for models absent from pi's builtin catalog. */
const FALLBACK_MODEL_METADATA = JSON.stringify({
  reasoning: false,
  thinkingLevelMap: {},
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costKnown: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
})

const PROTOCOL = /^https?:\/\//

const PLATFORM_TYPES: readonly string[] = [
  "ctfd",
  "a1ctf",
  "dasctf",
  "ret2shell",
  "tsecbench",
]

function isPlatformType(value: string): value is PlatformType {
  return PLATFORM_TYPES.includes(value)
}

export type BootstrapSpec = {
  provider?: {
    label: string
    type: ProviderType
    baseUrl: string
    apiKey: string
    modelId: string
    effort?: string
  }
  eventName?: string
  platform?: {
    type: PlatformType
    baseUrl: string
    credential: string
    remoteEventId?: string
  }
  schedulerInstruction?: string
  enqueueAll: boolean
}

export function readBootstrapSpec(env: Record<string, string | undefined>) {
  const spec: BootstrapSpec = { enqueueAll: env.AEGISX_ENQUEUE_ALL === "1" }
  if (env.AEGISX_PROVIDER_BASE_URL && env.AEGISX_MODEL_ID) {
    const type = env.AEGISX_PROVIDER_TYPE ?? "openai-compatible"
    if (
      type !== "openai-compatible" &&
      type !== "openai-responses" &&
      type !== "anthropic-messages"
    ) {
      throw new Error(`AEGISX_PROVIDER_TYPE is not a provider type: ${type}`)
    }
    const baseUrl = env.AEGISX_PROVIDER_BASE_URL
    if (!PROTOCOL.test(baseUrl)) {
      throw new Error("AEGISX_PROVIDER_BASE_URL must be an HTTP(S) URL")
    }
    spec.provider = {
      label: env.AEGISX_PROVIDER_LABEL ?? "Bootstrap",
      type,
      baseUrl,
      apiKey: env.AEGISX_PROVIDER_API_KEY ?? "",
      modelId: env.AEGISX_MODEL_ID,
      ...(env.AEGISX_MODEL_EFFORT ? { effort: env.AEGISX_MODEL_EFFORT } : {}),
    }
  }
  if (env.AEGISX_EVENT_NAME) spec.eventName = env.AEGISX_EVENT_NAME
  if (env.AEGISX_PLATFORM_TYPE && env.AEGISX_PLATFORM_BASE_URL) {
    const type = env.AEGISX_PLATFORM_TYPE
    if (!isPlatformType(type)) {
      throw new Error(`AEGISX_PLATFORM_TYPE is not a platform type: ${type}`)
    }
    spec.platform = {
      type,
      baseUrl: env.AEGISX_PLATFORM_BASE_URL,
      credential: env.AEGISX_PLATFORM_CREDENTIAL ?? "",
      ...(env.AEGISX_PLATFORM_REMOTE_EVENT_ID
        ? { remoteEventId: env.AEGISX_PLATFORM_REMOTE_EVENT_ID }
        : {}),
    }
  }
  if (env.AEGISX_SCHEDULER_INSTRUCTION) {
    spec.schedulerInstruction = env.AEGISX_SCHEDULER_INSTRUCTION
  }
  return spec
}

export type BootstrapDeps = {
  db: Database
  configStore: ConfigStore
  platformService: ReturnType<typeof createPlatformService>
  agentService: AgentService
}

/** Metadata for the configured model: pi's builtin catalog when the model id
 * matches a known entry, else the conservative fallback. */
function metadataFor(modelId: string): { metadata: string; source: string } {
  const profile = builtinModelProfiles().find((p) => p.modelId === modelId)
  if (profile) {
    return {
      metadata: JSON.stringify(profile.metadata),
      source: `pi:${profile.providerId}/${profile.modelId}`,
    }
  }
  return { metadata: FALLBACK_MODEL_METADATA, source: "bootstrap" }
}

/** Ensure the bootstrap provider + model match env; set the global default
 * model ref. Returns the ref (null when no provider was configured).
 * Exported for tests. */
export function ensureProvider(
  configStore: ConfigStore,
  spec: BootstrapSpec
): string | null {
  if (!spec.provider) return null
  const want = spec.provider
  const providers = configStore.getProviders()
  const index = providers.findIndex((p) => p.label === want.label)
  const base: ProviderData =
    index >= 0
      ? providers[index]
      : {
          id: "bootstrap-provider",
          label: want.label,
          type: want.type,
          baseUrl: want.baseUrl,
          apiKey: want.apiKey,
          enabled: true,
          models: [],
        }

  let provider: ProviderData = {
    ...base,
    type: want.type,
    baseUrl: want.baseUrl,
    apiKey: want.apiKey,
    enabled: true,
  }
  const modelIndex = provider.models.findIndex(
    (m) => m.modelId === want.modelId
  )
  if (modelIndex >= 0) {
    if (!provider.models[modelIndex].enabled) {
      provider = {
        ...provider,
        models: provider.models.map((m, i) =>
          i === modelIndex ? { ...m, enabled: true } : m
        ),
      }
    }
  } else {
    const meta = metadataFor(want.modelId)
    provider = {
      ...provider,
      models: [
        ...provider.models,
        {
          id: "bootstrap-model",
          modelId: want.modelId,
          label: want.modelId,
          enabled: true,
          metadata: meta.metadata,
          metadataSource: meta.source,
        },
      ],
    }
  }

  if (JSON.stringify(provider) !== JSON.stringify(base)) {
    const next =
      index >= 0
        ? providers.map((p, i) => (i === index ? provider : p))
        : [...providers, provider]
    configStore.updateProviders(next)
  }

  const model = provider.models.find((m) => m.modelId === want.modelId)!
  const ref = `${modelAddress(provider, model)}${want.effort ? `:${want.effort}` : ""}`
  if (configStore.getSettings()["agent.defaultModelRef"] !== ref) {
    configStore.updateSettings({ "agent.defaultModelRef": ref })
  }
  return ref
}

/** Find or create the event, then bind the platform if env asks for one and
 * no binding exists yet. Returns the event id (null when no event name). */
async function ensureEventAndPlatform(
  deps: BootstrapDeps,
  spec: BootstrapSpec
): Promise<string | null> {
  if (!spec.eventName) return null
  const { db } = deps
  const existing = db
    .select()
    .from(events)
    .where(eq(events.name, spec.eventName))
    .get()
  const eventId = existing?.id ?? crypto.randomUUID()
  if (!existing) {
    const now = new Date().toISOString()
    db.insert(events)
      .values({
        id: eventId,
        name: spec.eventName,
        promptHint: "",
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  if (spec.platform) {
    const bound = db
      .select()
      .from(eventPlatforms)
      .where(eq(eventPlatforms.eventId, eventId))
      .get()
    if (!bound) {
      await deps.platformService.bind(eventId, {
        type: spec.platform.type,
        baseUrl: spec.platform.baseUrl,
        credential: spec.platform.credential,
        remoteEventId: spec.platform.remoteEventId ?? "",
      })
      console.log("bootstrap: platform bound", {
        type: spec.platform.type,
        eventId,
      })
    }
  }
  return eventId
}

/** Sync every not-yet-imported remote challenge into the event. */
async function syncChallenges(deps: BootstrapDeps, eventId: string) {
  const bound = deps.db
    .select()
    .from(eventPlatforms)
    .where(eq(eventPlatforms.eventId, eventId))
    .get()
  if (!bound) return
  const { items } = await deps.platformService.discoverChallenges(eventId)
  const missing = items.filter((item) => !item.imported).map((item) => item.id)
  if (missing.length === 0) return
  await deps.platformService.syncChallenges(eventId, missing)
  console.log("bootstrap: challenges synced", {
    eventId,
    count: missing.length,
  })
}

/** Configure (first time only — later edits are the user's) and start the
 * event's scheduler; optionally enqueue a solver on every challenge. */
async function ensureScheduler(
  deps: BootstrapDeps,
  spec: BootstrapSpec,
  eventId: string,
  defaultModelRef: string | null
): Promise<void> {
  const { agentService, db } = deps
  const configured = db
    .select({ eventId: schedulerConfig.eventId })
    .from(schedulerConfig)
    .where(eq(schedulerConfig.eventId, eventId))
    .get()
  if (!configured) {
    agentService.upsertSchedulerConfig({
      eventId,
      ...(defaultModelRef ? { modelId: defaultModelRef } : {}),
      ...(spec.schedulerInstruction
        ? { instruction: spec.schedulerInstruction }
        : {}),
    })
  } else if (
    spec.schedulerInstruction &&
    !agentService.getSchedulerConfig(eventId).instruction
  ) {
    // Re-apply the env instruction while the user has not set their own.
    agentService.upsertSchedulerConfig({
      eventId,
      instruction: spec.schedulerInstruction,
    })
  }

  const agent = agentService.getSchedulerAgent(eventId)
  if (!agent || !isActiveAgentStatus(agent.status)) {
    await agentService.startScheduler(eventId)
    console.log("bootstrap: scheduler started", { eventId })
  }

  if (spec.enqueueAll) {
    const queue = agentService.queue()
    queue.resume(eventId)
    const rows = db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    const planned = new Set(
      queue
        .list(eventId)
        .filter(
          (item) => item.status === "pending" || item.status === "running"
        )
        .map((item) => item.challengeId)
    )
    let enqueued = 0
    for (const row of rows) {
      if (planned.has(row.id)) continue
      queue.enqueue({ eventId, challengeId: row.id, source: "manual" })
      enqueued++
    }
    if (enqueued > 0) await queue.drainOnce()
    console.log("bootstrap: solvers enqueued", { eventId, enqueued })
  }
}

export async function runBootstrap(
  deps: BootstrapDeps,
  spec: BootstrapSpec
): Promise<void> {
  if (!spec.provider && !spec.eventName) return
  const defaultModelRef = ensureProvider(deps.configStore, spec)
  const eventId = await ensureEventAndPlatform(deps, spec)
  if (!eventId) return
  await syncChallenges(deps, eventId)
  await ensureScheduler(deps, spec, eventId, defaultModelRef)
  console.log("bootstrap: complete", { eventId })
}
