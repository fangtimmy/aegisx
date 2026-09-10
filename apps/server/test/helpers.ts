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

import { createDatabase, type Database } from "../src/db"
import { agents, challenges, events } from "../src/db/schema"
import type {
  AgentPrincipal,
  Principal,
} from "../src/infrastructure/agent-auth"
import type {
  ConfigStore,
  ProviderData,
} from "../src/infrastructure/config-store"
import type { createPlatformService } from "../src/platforms/service"
import { builtinModelProfile } from "../src/providers/builtin-models"
import type { ContainerManager } from "../src/run/container/container-manager"
import type { HostAgentSession } from "../src/run/host/host-session"
import {
  createAgentService,
  type AgentService,
  type AgentServiceOptions,
} from "../src/run/service"
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

/** Principal fixtures for service-level tests. `agentPrincipal()` matches the
 * {@link seedAgent} defaults (evt-1 / ch-1 / solver) so most call sites need
 * only the agent id; the channel-post scope rules resolve the DB row, so the
 * fixture's event fields only matter for cross-event denial cases. */
export const USER: Principal = { kind: "user" }
export const SYSTEM: Principal = { kind: "system" }
export function agentPrincipal(
  agentId: string,
  overrides: {
    eventId?: string
    challengeId?: string | null
    role?: "solver" | "orchestrator"
  } = {}
): AgentPrincipal {
  return {
    kind: "agent",
    agentId,
    eventId: overrides.eventId ?? "evt-1",
    challengeId:
      overrides.challengeId !== undefined ? overrides.challengeId : "ch-1",
    role: overrides.role ?? "solver",
  }
}

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
    exactEndpoint: false,
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
  // Real pi queue semantics: steer()/followUp() append, clearQueue() drains
  // both, getSteeringMessages() reads the pending steers. The runtime's
  // steer-merge folds into this queue, so a stub that no-ops would hide it.
  const steering: string[] = []
  const followUps: string[] = []
  const session = {
    isStreaming: false,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: opts.hang ? () => new Promise(() => {}) : async () => {},
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async (text: string) => {
      steering.push(text)
    },
    followUp: async (text: string) => {
      followUps.push(text)
    },
    clearQueue: () => {
      const drained = {
        steering: [...steering],
        followUp: [...followUps],
      }
      steering.length = 0
      followUps.length = 0
      return drained
    },
    getSteeringMessages: () => [...steering],
  }
  return refine<HostAgentSession>({
    session,
    sessionId,
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  })
}

type PlatformService = ReturnType<typeof createPlatformService>

/** createHost stub that records every prompt text per agent id. With `hang`
 * (default false) turns never settle, so spawned agents stay "running"; with
 * hang off, turns settle and `agent.idle` fires. */
export function promptRecordingHost(
  promptLog: Map<string, string[]>,
  opts: { hang?: boolean } = {}
): AgentServiceOptions["createHost"] {
  return async (input) => {
    const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
      hang: opts.hang ?? false,
    })
    const list: string[] = []
    promptLog.set(input.agentId, list)
    const sdk = refine<{ prompt: (text: string) => Promise<void> }>(
      stub.session
    )
    sdk.prompt = async (text: string) => {
      list.push(text)
    }
    return stub
  }
}

/** One assembled agent service plus everything its tests assert on. */
type AgentServiceHarness = {
  service: AgentService
  db: Database
  /** Workspace data dir handed to the service (workspace trees land here). */
  dir: string
  /** Closes the service, then the db (unless an external `store` was injected —
   * then only the service; the caller owns the store). */
  close: () => Promise<void>
  /** Captured calls of the default recording container manager (the same
   * arrays `stubContainerManager()` returns). Meaningless when a custom
   * `containerManager` was injected. */
  stubs: { created: unknown[]; killed: string[]; removed: string[] }
}

/** Assemble the canonical test agent service: fresh on-disk SQLite + seeded
 * event/challenge rows + recording container manager + no-op platform service
 * + test provider. Every knob is overridable per member; tests pass only what
 * makes them distinct. */
export function makeAgentService(
  opts: {
    /** Seed the canonical event row (default "evt-1"; `false` skips). */
    event?: string | false
    /** Seed the canonical challenge row on the event (default "ch-1"; `false` skips). */
    challenge?: string | false
    /** Reuse an existing setupDb() store instead of a fresh one (multi-service
     * tests); the caller owns closing it. */
    store?: ReturnType<typeof setupDb>
    /** Providers the config store exposes (default: one {@link makeProvider}). */
    providers?: ProviderData[]
    /** Settings seam (default: {@link flatSettingsWithDefaultModel}). */
    getSettings?: AgentServiceOptions["getSettings"]
    /** Per-member replacement on top of the no-op platformService defaults. */
    platformService?: Partial<
      Pick<PlatformService, "submitFlag" | "targetAction">
    >
    /** Replace the default recording container manager entirely. */
    containerManager?: ContainerManager
  } & Partial<
    Pick<
      AgentServiceOptions,
      | "createHost"
      | "timeoutGraceMs"
      | "closeAbortGraceMs"
      | "sweepIntervalMs"
      | "idleTtlMs"
      | "flushIntervalMs"
      | "stallMs"
      | "solvedWrapupMs"
      | "clock"
      | "unattended"
    >
  >
): AgentServiceHarness {
  const store = opts.store ?? setupDb()
  const ownsStore = opts.store === undefined
  const event = opts.event === undefined ? "evt-1" : opts.event
  const challenge = opts.challenge === undefined ? "ch-1" : opts.challenge
  if (event) seedEvent(store.db, event)
  if (challenge && event) {
    seedChallenge(store.db, { id: challenge, eventId: event })
  }

  const { manager, created, killed, removed } = stubContainerManager()
  const service = createAgentService({
    db: store.db,
    dataDir: store.dir,
    containerManager: opts.containerManager ?? manager,
    relayOrigin: "http://127.0.0.1:3000",
    platformService: refine<PlatformService>({
      submitFlag: async () => undefined,
      targetAction: async () => ({
        status: "running",
        endpoints: [],
        expiresAt: null,
      }),
      ...opts.platformService,
    }),
    configStore: stubConfigStore(opts.providers ?? [makeProvider()]),
    getSettings: opts.getSettings ?? flatSettingsWithDefaultModel,
    createHost: opts.createHost ?? (async () => stubHostAgentSession()),
    timeoutGraceMs: opts.timeoutGraceMs,
    closeAbortGraceMs: opts.closeAbortGraceMs,
    sweepIntervalMs: opts.sweepIntervalMs,
    idleTtlMs: opts.idleTtlMs,
    flushIntervalMs: opts.flushIntervalMs,
    stallMs: opts.stallMs,
    solvedWrapupMs: opts.solvedWrapupMs,
    unattended: opts.unattended ?? false,
    ...(opts.clock ? { clock: opts.clock } : {}),
  })
  let closed = false
  return {
    service,
    db: store.db,
    dir: store.dir,
    close: async () => {
      if (closed) return
      closed = true
      await service.close()
      if (ownsStore) store.close()
    },
    stubs: { created, killed, removed },
  }
}
