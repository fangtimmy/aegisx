/**
 * Shared test scaffolding for service-level tests. Keeps the orchestration
 * chain (container create → DB insert → provision → cleanup) testable without
 * a real Docker daemon or a real pi model: container + host-session + config
 * store are stubbed, the DB is a real on-disk SQLite.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defaultSettings } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"

import type { HostAgentSession } from "../src/agents/host-session"
import { createDatabase, type Database } from "../src/db"
import { challenges, events, runs } from "../src/db/schema"
import type {
  ConfigStore,
  ProviderData,
} from "../src/infrastructure/config-store"
import { mapProviderConnection } from "../src/providers/public"
import type { ContainerManager } from "../src/run/container/container-manager"

/** Fresh on-disk SQLite on a temp dir. FKs left on (tests seed real graphs). */
export function setupDb(): {
  db: Database
  sqlite: ReturnType<typeof createDatabase>["sqlite"]
  dir: string
  close: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-test-"))
  const { db, sqlite, releaseLock } = createDatabase(dir)
  return {
    db,
    sqlite,
    dir,
    close: () => {
      sqlite.close()
      releaseLock()
    },
  }
}

export const now = () => new Date("2025-01-01T00:00:00Z").toISOString()

export function seedEvent(db: Database, id = "evt-1") {
  db.insert(events)
    .values({
      id,
      name: "Test Event",
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
  return id
}

export function seedChallenge(
  db: Database,
  overrides: Partial<typeof challenges.$inferInsert> & {
    id?: string
    eventId?: string
  } = {}
) {
  const id = overrides.id ?? "ch-1"
  const eventId = overrides.eventId ?? "evt-1"
  db.insert(challenges)
    .values({
      id,
      eventId,
      name: "Test Challenge",
      description: "desc",
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run()
  return id
}

export function seedRun(
  db: Database,
  overrides: Partial<typeof runs.$inferInsert> & {
    id?: string
    eventId?: string
    challengeId?: string | null
  } = {}
) {
  const id = overrides.id ?? "run-1"
  const eventId = overrides.eventId ?? "evt-1"
  const challengeId =
    overrides.challengeId === undefined ? "ch-1" : overrides.challengeId
  db.insert(runs)
    .values({
      id,
      scopeType: "challenge",
      eventId,
      challengeId,
      status: "closed",
      model: `${TEST_MODEL_REF}:off`,
      image: "img",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 64,
      containerName: "c",
      workspacePath: "w",
      sessionDir: "s",
      source: "manual",
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run()
  return id
}

/** Minimal custom (non-piBinding) provider with one enabled model. metadata
 * "{}" parses to defaults via parseModelMetadata. */
export function makeProvider(
  overrides: Partial<ProviderData> = {}
): ProviderData {
  return {
    id: "prov-1",
    label: "Test Provider",
    type: "openai-compatible",
    baseUrl: "",
    apiKey: "test-key",
    enabled: true,
    models: [
      {
        id: "model-1",
        modelId: "gpt-4o-mini",
        label: "Test Model",
        enabled: true,
        metadata: "{}",
        // Bind to a real pi builtin so ModelRuntime.getModel resolves offline
        // (custom-provider keys aren't registered without a catalog entry).
        piProviderId: "openai",
        piModelId: "gpt-4o-mini",
      },
    ],
    ...overrides,
  }
}

/** ProviderData → ProviderConnection (the shape runService.create receives). */
export function toConnection(provider: ProviderData): ProviderConnection {
  return mapProviderConnection(provider)
}

/** ConfigStore stub exposing only what the services read (getProviders). */
export function stubConfigStore(providers: ProviderData[]): ConfigStore {
  return {
    getProviders: () => providers,
    getAliases: () => [],
    getAgentModels: () => ({}),
    getLegacyPromptTemplates: () => undefined,
  } as unknown as ConfigStore
}

export const flatSettings = () => defaultSettings()

/** Canonical model ref for the {@link makeProvider} test provider (pi-bound
 * openai/gpt-4o-mini). Used as the default-model ref and per-slot overrides
 * so the service's slot-model resolution succeeds in tests. */
export const TEST_MODEL_REF = "openai/gpt-4o-mini"

/** flatSettings with the default model set to the test provider's model, so
 * runService.create() can resolve slot models without an explicit override. */
export function flatSettingsWithDefaultModel(
  ref: string = `${TEST_MODEL_REF}:off`
) {
  return { ...defaultSettings(), "agent.defaultModelId": ref }
}

/** Records create/kill/remove calls; all methods are no-ops that succeed. */
export function stubContainerManager() {
  const created: unknown[] = []
  const killed: string[] = []
  const removed: string[] = []
  const manager = {
    create: async (opts: unknown) => {
      created.push(opts)
      return { id: "container-id" }
    },
    remove: async (name: string) => {
      removed.push(name)
    },
    kill: async (name: string) => {
      killed.push(name)
    },
    isRunning: async () => false,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    putArchive: async () => {},
    get: () => ({}),
  } as unknown as ContainerManager
  return { manager, created, killed, removed }
}

/** No-op HostAgentSession. By default prompt resolves; pass `hang` to leave the
 * turn pending so a created run stays deterministically "running" (avoids
 * racing the async turn-settle in create() tests). */
export function stubHostAgentSession(
  sessionId = "stub-session",
  opts: { hang?: boolean } = {}
): HostAgentSession {
  const session = {
    isStreaming: false,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: opts.hang ? () => new Promise(() => {}) : async () => {},
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => {},
  }
  return {
    session: session as never,
    sessionId,
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  } as unknown as HostAgentSession
}
