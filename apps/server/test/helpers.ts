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

import type { HostAgentSession } from "../src/agents/host-session"
import { createDatabase, type Database } from "../src/db"
import { agents, challenges, events } from "../src/db/schema"
import type {
  ConfigStore,
  ProviderData,
} from "../src/infrastructure/config-store"
import { builtinModelProfile } from "../src/providers/builtin-models"
import type { ContainerManager } from "../src/run/container/container-manager"
import { refine } from "./support"

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

export function seedAgent(
  db: Database,
  overrides: Partial<typeof agents.$inferInsert> & {
    id?: string
    eventId?: string
    challengeId?: string | null
  } = {}
) {
  const id = overrides.id ?? "agent-1"
  const eventId = overrides.eventId ?? "evt-1"
  const challengeId =
    overrides.challengeId === undefined ? "ch-1" : overrides.challengeId
  db.insert(agents)
    .values({
      id,
      eventId,
      challengeId,
      role: "solver",
      name: `agent-${id.slice(0, 8)}`,
      model: `${TEST_MODEL_REF}:off`,
      systemPrompt: "sys",
      tools: "[]",
      status: "idle",
      sessionFile: null,
      prompt: null,
      source: "manual",
      timeoutMs: 3_600_000,
      deadlineAt: null,
      createdAt: now(),
      startedAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run()
  return id
}

/** Minimal provider with one enabled model. metadata carries the real
 * pi-builtin gpt-4o-mini profile so ModelRuntime.getModel resolves offline
 * (custom models.json entries are registered without a catalog fetch). */
export function makeProvider(
  overrides: Partial<ProviderData> = {}
): ProviderData {
  return {
    id: "prov-1",
    label: "Test Provider",
    type: "openai-compatible",
    baseUrl: "https://api.test.invalid/v1",
    apiKey: "test-key",
    enabled: true,
    models: [makeModel()],
    ...overrides,
  }
}

export function makeModel(
  overrides: Partial<ProviderData["models"][number]> = {}
): ProviderData["models"][number] {
  const profile = builtinModelProfile("openai", "gpt-4o-mini")
  return {
    id: "model-1",
    modelId: "gpt-4o-mini",
    label: "Test Model",
    enabled: true,
    metadata: JSON.stringify(profile?.metadata ?? {}),
    metadataSource: "pi:openai/gpt-4o-mini",
    ...overrides,
  }
}

/** ConfigStore stub exposing only what the services read (getProviders). */
export function stubConfigStore(providers: ProviderData[]): ConfigStore {
  return refine<ConfigStore>({
    getProviders: () => providers,
    getLegacyPromptTemplates: () => undefined,
  })
}

export const flatSettings = () => defaultSettings()

/** Canonical model ref for the {@link makeProvider} test provider
 * (`aegisx-prov-1/gpt-4o-mini`). Used as the default-model ref and per-slot
 * overrides so the service's slot-model resolution succeeds in tests. */
export const TEST_MODEL_REF = "aegisx-prov-1/gpt-4o-mini"

/** flatSettings with the default model set to the test provider's model, so
 * runService.create() can resolve slot models without an explicit override. */
export function flatSettingsWithDefaultModel(
  ref: string = `${TEST_MODEL_REF}:off`
) {
  return { ...defaultSettings(), "agent.defaultModelRef": ref }
}

/** Records create/kill/remove calls; all methods are no-ops that succeed. */
export function stubContainerManager() {
  const created: unknown[] = []
  const killed: string[] = []
  const removed: string[] = []
  const stub = {
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
    isRunning: async () => true,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    putArchive: async () => {},
    get: () => ({}),
  }
  const manager = refine<ContainerManager>(stub)
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
  return refine<HostAgentSession>({
    session,
    sessionId,
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  })
}
