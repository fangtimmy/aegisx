import { existsSync, readFileSync } from "node:fs"

import {
  isActiveAgentStatus,
  isRecord,
  modelAddress,
  type PlatformType,
  type ProviderType,
} from "@aegisx/shared"
import { eq } from "drizzle-orm"

import type { Database } from "./db"
import { events, eventPlatforms, schedulerConfig } from "./db/schema"
import type { ConfigStore, ProviderData } from "./infrastructure/config-store"
import { parseJson } from "./lib/guards"
import type { createPlatformService } from "./platforms/service"
import {
  builtinModelProfile,
  builtinModelProfiles,
  type ModelMetadata,
  normalizeModelMetadata,
} from "./providers/builtin-models"
import type { AgentService } from "./run/service"

/**
 * Appliance bootstrap (AEGISX_BOOTSTRAP=1): turn env vars into a fully
 * configured instance — LLM provider + default model, event + platform
 * binding, challenge sync, a running scheduler. Idempotent: existing
 * resources are matched and only completed — bootstrap fills absent values
 * and adds missing models, never overwriting user edits, so a container
 * restart on a persistent data dir converges without duplicating anything.
 * Failures log and leave the server up (the UI stays usable for
 * manual repair). The TSecBench hosted harness injects BENCHMARK_BASE_URL /
 * BENCHMARK_TOKEN instead of the AEGISX_PLATFORM_* names — accepted as
 * fallbacks (AEGISX_* wins), with the platform type defaulting to tsecbench
 * when only BENCHMARK_BASE_URL is given.
 */

/** Metadata layers for a bootstrap model, most specific first:
 * AEGISX_MODEL_PROFILE (explicit pi catalog binding — the deployed model id
 * may be a gateway-specific variant) > pi catalog match by model id >
 * conservative fallback. AEGISX_MODEL_METADATA fields merge over whichever
 * base wins. AEGISX_MODEL_EFFORT infers reasoning only on the fallback layer
 * (an empty thinkingLevelMap passes the level through), so the effort suffix
 * is not a silent no-op. */
function metadataFor(
  modelId: string,
  want?: {
    effort?: string
    profile?: string
    overrides?: Record<string, unknown>
  }
): { metadata: ModelMetadata; source: string } {
  const base = want?.profile
    ? resolveBuiltinProfile(want.profile)
    : builtinModelProfiles().find((p) => p.modelId === modelId)
  if (base) {
    return {
      metadata: want?.overrides
        ? normalizeModelMetadata({ ...base.metadata, ...want.overrides })
        : base.metadata,
      source: want?.overrides ? "env" : `pi:${base.providerId}/${base.modelId}`,
    }
  }
  return {
    metadata: normalizeModelMetadata({
      ...(want?.effort ? { reasoning: true } : {}),
      ...want?.overrides,
    }),
    source: want?.overrides ? "env" : "bootstrap",
  }
}

/** Resolve AEGISX_MODEL_PROFILE as "providerId/modelId" — the first slash
 * splits, catalog model ids may themselves contain slashes. */
function resolveBuiltinProfile(ref: string) {
  const sep = ref.indexOf("/")
  const profile =
    sep > 0
      ? builtinModelProfile(ref.slice(0, sep), ref.slice(sep + 1))
      : undefined
  if (!profile) {
    throw new Error(`AEGISX_MODEL_PROFILE is not a builtin model: ${ref}`)
  }
  return profile
}

/** Parse AEGISX_MODEL_METADATA into a record mergeable over the metadata
 * base. Throws on malformed JSON or a non-object payload — the caller treats
 * env validation errors as bootstrap failures. */
function modelMetadataInput(raw: string): Record<string, unknown> {
  const parsed: unknown = parseJson(raw)
  if (!isRecord(parsed)) {
    throw new Error("AEGISX_MODEL_METADATA must be a JSON object")
  }
  return parsed
}

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
    /** Resolved metadata (AEGISX_MODEL_PROFILE / AEGISX_MODEL_METADATA) —
     * wins over pi's builtin catalog and the conservative fallback. */
    modelMetadata?: { metadata: ModelMetadata; source: string }
  }
  eventName?: string
  platform?: {
    type: PlatformType
    baseUrl: string
    credential: string
    remoteEventId?: string
  }
  schedulerInstruction?: string
}

/** Path convention for appliance event presets. A preset bakes deployment
 * tuning (platform brief, settings, scheduler policy) as DATA instead of
 * build-time source rewrites; absent file = no-op, so non-appliance
 * deployments are unaffected. */
const EVENT_PRESET_PATH = "/opt/aegisx-preset/preset.json"

export type EventPreset = {
  /** Event-level platform brief, injected into agent prompts verbatim. */
  promptHint?: string
  /** Global settings overrides (flat `key` → scalar). */
  settings?: Record<string, string | number | boolean>
  /** First-boot scheduler policy (the event's 调度设置). */
  scheduler?: {
    maxConcurrentTargets?: number
    notifyTeamOnFlag?: boolean
    stopSiblingsOnSolve?: boolean
    stopTargetOnSolve?: boolean
    stopSubmitterOnSolve?: boolean
    nextTaskPolicy?: "eager" | "drained"
    urgentTeamMessages?: boolean
    blockSpawnOnSolved?: boolean
  }
}

/** Top-level shape check; deep fields are validated by their consumers
 * (patchSettings for settings, upsertSchedulerConfig for the policy). */
function isEventPreset(doc: unknown): doc is EventPreset {
  if (!isRecord(doc)) return false
  if (doc.promptHint !== undefined && typeof doc.promptHint !== "string")
    return false
  if (doc.settings !== undefined && !isRecord(doc.settings)) return false
  if (doc.scheduler !== undefined && !isRecord(doc.scheduler)) return false
  return true
}

/** Read the appliance preset. A missing file is normal (no preset); an
 * unreadable one is logged and skipped — bootstrap stays up, same as every
 * other bootstrap failure. */
export function readEventPreset(
  path: string = EVENT_PRESET_PATH
): EventPreset | null {
  if (!existsSync(path)) return null
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isEventPreset(doc)) throw new Error("preset root is not an object")
    return doc
  } catch (error) {
    console.error("bootstrap: event preset unreadable — ignoring", {
      path,
      error,
    })
    return null
  }
}

/** Converge global settings onto the preset values — drift-only writes, the
 * same idempotent semantics as ensureProvider. */
export function ensurePresetSettings(
  configStore: ConfigStore,
  preset: EventPreset | null
): void {
  if (!preset?.settings) return
  const current: Record<string, unknown> = configStore.getSettings()
  const patch: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(preset.settings)) {
    if (current[key] !== value) patch[key] = value
  }
  if (Object.keys(patch).length > 0) {
    configStore.updateSettings(patch)
    console.log("bootstrap: preset settings applied", {
      keys: Object.keys(patch),
    })
  }
}

export function readBootstrapSpec(env: Record<string, string | undefined>) {
  const spec: BootstrapSpec = {}
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
      ...(env.AEGISX_MODEL_PROFILE || env.AEGISX_MODEL_METADATA
        ? {
            modelMetadata: metadataFor(env.AEGISX_MODEL_ID, {
              effort: env.AEGISX_MODEL_EFFORT,
              profile: env.AEGISX_MODEL_PROFILE,
              overrides: env.AEGISX_MODEL_METADATA
                ? modelMetadataInput(env.AEGISX_MODEL_METADATA)
                : undefined,
            }),
          }
        : {}),
    }
  }
  if (env.AEGISX_EVENT_NAME) spec.eventName = env.AEGISX_EVENT_NAME
  const platformType =
    env.AEGISX_PLATFORM_TYPE ??
    (env.BENCHMARK_BASE_URL ? "tsecbench" : undefined)
  const platformBaseUrl = env.AEGISX_PLATFORM_BASE_URL ?? env.BENCHMARK_BASE_URL
  if (platformType && platformBaseUrl) {
    if (!isPlatformType(platformType)) {
      throw new Error(
        `AEGISX_PLATFORM_TYPE is not a platform type: ${platformType}`
      )
    }
    spec.platform = {
      type: platformType,
      baseUrl: platformBaseUrl,
      credential: env.AEGISX_PLATFORM_CREDENTIAL ?? env.BENCHMARK_TOKEN ?? "",
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
  /** Override for EVENT_PRESET_PATH (tests). */
  presetPath?: string
}

/** Ensure the bootstrap provider + model exist. Merge, never clobber: env
 * fills only absent/empty fields (baseUrl/apiKey/type) and contributes the
 * wanted model (added when missing, re-enabled when disabled) — non-empty
 * values the user edited via the UI survive every restart. The default model
 * ref is seeded only when this run contributed something AND the slot is
 * still unclaimed, so a user pick (or clear) is never restored away.
 * Returns the ref (null when no provider was configured). Exported for
 * tests. */
export function ensureProvider(
  configStore: ConfigStore,
  spec: BootstrapSpec
): string | null {
  if (!spec.provider) return null
  const want = spec.provider
  const providers = configStore.getProviders()
  const index = providers.findIndex((p) => p.label === want.label)

  let changed: boolean
  let provider: ProviderData
  if (index < 0) {
    changed = true
    provider = {
      id: "bootstrap-provider",
      label: want.label,
      type: want.type,
      baseUrl: want.baseUrl,
      apiKey: want.apiKey,
      enabled: true,
      models: [],
    }
  } else {
    const base = providers[index]
    provider = {
      ...base,
      type: base.type || want.type,
      baseUrl: base.baseUrl || want.baseUrl,
      apiKey: base.apiKey || want.apiKey,
    }
    changed =
      provider.type !== base.type ||
      provider.baseUrl !== base.baseUrl ||
      provider.apiKey !== base.apiKey
  }

  const modelIndex = provider.models.findIndex(
    (m) => m.modelId === want.modelId
  )
  if (modelIndex >= 0) {
    if (!provider.models[modelIndex].enabled) {
      changed = true
      provider = {
        ...provider,
        models: provider.models.map((m, i) =>
          i === modelIndex ? { ...m, enabled: true } : m
        ),
      }
    }
  } else {
    changed = true
    const meta =
      want.modelMetadata ?? metadataFor(want.modelId, { effort: want.effort })
    provider = {
      ...provider,
      models: [
        ...provider.models,
        {
          id: "bootstrap-model",
          modelId: want.modelId,
          label: want.modelId,
          enabled: true,
          metadata: JSON.stringify(meta.metadata),
          metadataSource: meta.source,
        },
      ],
    }
  }

  if (changed) {
    const next =
      index >= 0
        ? providers.map((p, i) => (i === index ? provider : p))
        : [...providers, provider]
    configStore.updateProviders(next)
    const model = provider.models.find((m) => m.modelId === want.modelId)!
    const ref = `${modelAddress(provider, model)}${want.effort ? `:${want.effort}` : ""}`
    if (!configStore.getSettings()["agent.defaultModelRef"]) {
      configStore.updateSettings({ "agent.defaultModelRef": ref })
    }
    return ref
  }
  // Nothing contributed: the ref (set or cleared) is whatever the user left.
  const existing = configStore.getSettings()["agent.defaultModelRef"]
  return existing ?? null
}

/** Find or create the event, then bind the platform if env asks for one and
 * no binding exists yet. Returns the event id (null when no event name). */
async function ensureEventAndPlatform(
  deps: BootstrapDeps,
  spec: BootstrapSpec,
  preset: EventPreset | null
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
        promptHint: preset?.promptHint ?? "",
        createdAt: now,
        updatedAt: now,
      })
      .run()
  } else if (preset?.promptHint && !existing.promptHint) {
    // Backfill an empty hint on re-bootstrap; a set hint is the user's —
    // preset updates ship with a fresh data dir, not over edits.
    const now = new Date().toISOString()
    db.update(events)
      .set({ promptHint: preset.promptHint, updatedAt: now })
      .where(eq(events.id, eventId))
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
  defaultModelRef: string | null,
  preset: EventPreset | null
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
      ...preset?.scheduler,
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
}

export async function runBootstrap(
  deps: BootstrapDeps,
  spec: BootstrapSpec
): Promise<void> {
  if (!spec.provider && !spec.eventName) return
  const preset = readEventPreset(deps.presetPath)
  ensurePresetSettings(deps.configStore, preset)
  const defaultModelRef = ensureProvider(deps.configStore, spec)
  const eventId = await ensureEventAndPlatform(deps, spec, preset)
  if (!eventId) return
  await syncChallenges(deps, eventId)
  await ensureScheduler(deps, spec, eventId, defaultModelRef, preset)
  console.log("bootstrap: complete", { eventId })
}
