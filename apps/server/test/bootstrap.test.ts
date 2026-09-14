import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseEventPromptBrief } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import {
  ensurePresetSettings,
  ensureProvider,
  readBootstrapSpec,
  readEventPreset,
  runBootstrap,
  syncChallenges,
  type BootstrapDeps,
  type EventPreset,
} from "../src/bootstrap"
import { events, eventPlatforms } from "../src/db/schema"
import { createConfigStore } from "../src/infrastructure/config-store"
import type { ConfigStore } from "../src/infrastructure/config-store"
import { setupDb, now } from "./helpers"
import { refine } from "./support"

function specFrom(env: Record<string, string | undefined>) {
  const spec = readBootstrapSpec(env)
  return { spec, provider: spec.provider }
}

/** Minimal ConfigStore double over a plain settings record. */
function fakeConfigStore(settings: Record<string, string | number | boolean>) {
  return refine<ConfigStore>({
    getSettings: () => settings,
    updateSettings: (patch: Record<string, string | number | boolean>) => {
      Object.assign(settings, patch)
    },
  })
}

function fakeAgentService(applied: Array<Record<string, unknown>>) {
  return refine<BootstrapDeps["agentService"]>({
    upsertSchedulerConfig: (patch: Record<string, unknown>) => {
      applied.push(patch)
    },
    getSchedulerConfig: () => ({ instruction: "" }),
    // An already-active scheduler agent keeps ensureScheduler past its
    // startScheduler branch (these tests don't exercise agent spawning).
    getSchedulerAgent: () => ({ id: "sched-1", status: "idle" }),
    startScheduler: async () => {
      throw new Error("not reached: these tests stop before scheduler start")
    },
    queue: () => {
      throw new Error("not reached: these tests stop before queueing")
    },
  })
}

describe("readBootstrapSpec", () => {
  test("parses a full appliance env", () => {
    const { spec } = specFrom({
      AEGISX_PROVIDER_TYPE: "openai-responses",
      AEGISX_PROVIDER_BASE_URL: "http://10.0.0.8:8080/v1",
      AEGISX_PROVIDER_API_KEY: "sk-test",
      AEGISX_PROVIDER_LABEL: "Gateway",
      AEGISX_PROVIDER_EXACT_ENDPOINT: "1",
      AEGISX_MODEL_ID: "glm-5.3",
      AEGISX_MODEL_EFFORT: "high",
      AEGISX_EVENT_NAME: "Qualifier",
      AEGISX_PLATFORM_TYPE: "ctfd",
      AEGISX_PLATFORM_BASE_URL: "https://ctf.example.com",
      AEGISX_PLATFORM_CREDENTIAL: "tok",
      AEGISX_PLATFORM_REMOTE_EVENT_ID: "7",
      AEGISX_SCHEDULER_INSTRUCTION: "go wide",
    })
    expect(spec.provider).toEqual({
      label: "Gateway",
      type: "openai-responses",
      baseUrl: "http://10.0.0.8:8080/v1",
      apiKey: "sk-test",
      exactEndpoint: true,
      modelId: "glm-5.3",
      effort: "high",
    })
    expect(spec.eventName).toBe("Qualifier")
    expect(spec.platform).toEqual({
      type: "ctfd",
      baseUrl: "https://ctf.example.com",
      credential: "tok",
      remoteEventId: "7",
    })
    expect(spec.schedulerInstruction).toBe("go wide")
  })

  test("defaults: openai-compatible, no effort, no platform, no enqueue", () => {
    const { spec } = specFrom({
      AEGISX_PROVIDER_BASE_URL: "https://api.example.com/v1",
      AEGISX_PROVIDER_API_KEY: "k",
      AEGISX_MODEL_ID: "m",
    })
    expect(spec.provider?.type).toBe("openai-compatible")
    expect(spec.provider?.effort).toBeUndefined()
    expect(spec.provider?.exactEndpoint).toBeUndefined()
    expect(spec.platform).toBeUndefined()
    expect(spec.eventName).toBeUndefined()
  })

  test("a platform binding without an event name derives one", () => {
    // Hosted harnesses inject only BENCHMARK_*; the appliance must not
    // silently skip event/platform/scheduler for a missing name.
    const { spec } = specFrom({
      BENCHMARK_BASE_URL: "https://bench.example.com",
      BENCHMARK_TOKEN: "tok",
    })
    expect(spec.eventName).toBe("tsecbench")
    expect(spec.platform?.type).toBe("tsecbench")
    expect(spec.platform?.credential).toBe("tok")
    const explicit = specFrom({
      AEGISX_EVENT_NAME: "my-event",
      BENCHMARK_BASE_URL: "https://bench.example.com",
      BENCHMARK_TOKEN: "tok",
    })
    expect(explicit.spec.eventName).toBe("my-event")
  })

  test("provider requires both base URL and model id", () => {
    expect(
      specFrom({ AEGISX_PROVIDER_BASE_URL: "https://x" }).provider
    ).toBeUndefined()
    expect(specFrom({ AEGISX_MODEL_ID: "m" }).provider).toBeUndefined()
  })

  test("rejects unknown provider and platform types and non-http URLs", () => {
    expect(
      () =>
        specFrom({
          AEGISX_PROVIDER_BASE_URL: "https://x",
          AEGISX_MODEL_ID: "m",
          AEGISX_PROVIDER_TYPE: "bogus",
        }).provider
    ).toThrow(/provider type/)
    expect(() =>
      specFrom({
        AEGISX_PROVIDER_BASE_URL: "ftp://x",
        AEGISX_MODEL_ID: "m",
      })
    ).toThrow(/HTTP/)
    expect(() =>
      specFrom({
        AEGISX_PLATFORM_TYPE: "bogus",
        AEGISX_PLATFORM_BASE_URL: "https://x",
      })
    ).toThrow(/platform type/)
  })

  test("AEGISX_MODEL_METADATA merges over the effort inference", () => {
    const { provider } = specFrom({
      AEGISX_PROVIDER_BASE_URL: "https://api.example.com/v1",
      AEGISX_MODEL_ID: "m",
      AEGISX_MODEL_EFFORT: "high",
      AEGISX_MODEL_METADATA:
        '{"contextWindow": 200000, "maxTokens": 65536, "input": ["text", "image"]}',
    })
    expect(provider?.modelMetadata).toEqual({
      source: "env",
      metadata: {
        reasoning: true,
        thinkingLevelMap: {},
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costKnown: false,
        contextWindow: 200_000,
        maxTokens: 65_536,
      },
    })
  })

  test("AEGISX_MODEL_PROFILE binds catalog metadata regardless of model id", () => {
    const { provider } = specFrom({
      AEGISX_PROVIDER_BASE_URL: "https://api.example.com/v1",
      AEGISX_MODEL_ID: "glm-5.3-flash",
      AEGISX_MODEL_EFFORT: "high",
      AEGISX_MODEL_PROFILE: "zai/glm-5.3",
    })
    expect(provider?.modelMetadata?.source).toBe("pi:zai/glm-5.3")
    expect(provider?.modelMetadata?.metadata.reasoning).toBe(true)
    expect(provider?.modelMetadata?.metadata.contextWindow).toBe(1_000_000)
    expect(provider?.modelMetadata?.metadata.compat).toBeDefined()
  })

  test("metadata fields merge over the bound profile", () => {
    const { provider } = specFrom({
      AEGISX_PROVIDER_BASE_URL: "https://api.example.com/v1",
      AEGISX_MODEL_ID: "glm-5.3-flash",
      AEGISX_MODEL_PROFILE: "zai/glm-5.3",
      AEGISX_MODEL_METADATA: '{"maxTokens": 65536}',
    })
    expect(provider?.modelMetadata?.source).toBe("env")
    expect(provider?.modelMetadata?.metadata.maxTokens).toBe(65_536)
    expect(provider?.modelMetadata?.metadata.contextWindow).toBe(1_000_000)
  })

  test("explicit metadata fields win over the effort inference", () => {
    const { provider } = specFrom({
      AEGISX_PROVIDER_BASE_URL: "https://api.example.com/v1",
      AEGISX_MODEL_ID: "m",
      AEGISX_MODEL_EFFORT: "high",
      AEGISX_MODEL_METADATA: '{"reasoning": false}',
    })
    expect(provider?.modelMetadata?.metadata.reasoning).toBe(false)
  })

  test("rejects malformed metadata and unknown model profiles", () => {
    const base = {
      AEGISX_PROVIDER_BASE_URL: "https://api.example.com/v1",
      AEGISX_MODEL_ID: "m",
    }
    expect(() =>
      specFrom({ ...base, AEGISX_MODEL_METADATA: "{oops" })
    ).toThrow()
    expect(() => specFrom({ ...base, AEGISX_MODEL_METADATA: '"x"' })).toThrow(
      /JSON object/
    )
    expect(() =>
      specFrom({ ...base, AEGISX_MODEL_METADATA: '{"bogus": 1}' })
    ).toThrow(/Unknown metadata field/)
    expect(() =>
      specFrom({ ...base, AEGISX_MODEL_PROFILE: "no-such/model" })
    ).toThrow(/not a builtin model/)
    expect(() =>
      specFrom({ ...base, AEGISX_MODEL_PROFILE: "noslash" })
    ).toThrow(/not a builtin model/)
  })

  describe("organizer contract variables", () => {
    const contract = {
      PLATFORM_BASE_URL: "https://pro.example.com",
      PLATFORM_ACCESS_KEY: "ak_live_x",
      LLM_BASE_URL: "https://gw.example.com/llm",
      LLM_API_KEY: "sk-1",
      // Deployment facts baked into the appliance image ENV.
      AEGISX_PLATFORM_TYPE: "dasctf",
      AEGISX_MODEL_ID: "deepseek-flash",
    }

    test("the four contract variables alone configure provider and platform", () => {
      const { spec } = specFrom(contract)
      expect(spec.provider).toMatchObject({
        baseUrl: "https://gw.example.com/llm",
        apiKey: "sk-1",
        modelId: "deepseek-flash",
      })
      expect(spec.platform).toEqual({
        type: "dasctf",
        baseUrl: "https://pro.example.com",
        credential: "ak_live_x",
      })
    })

    test("contract variables win over the AEGISX_* names", () => {
      const { spec } = specFrom({
        ...contract,
        AEGISX_PLATFORM_BASE_URL: "https://legacy-platform.example.com",
        AEGISX_PLATFORM_CREDENTIAL: "ak_legacy",
        AEGISX_PROVIDER_BASE_URL: "https://legacy-gw.example.com",
        AEGISX_PROVIDER_API_KEY: "sk-legacy",
      })
      expect(spec.provider?.baseUrl).toBe("https://gw.example.com/llm")
      expect(spec.provider?.apiKey).toBe("sk-1")
      expect(spec.platform?.baseUrl).toBe("https://pro.example.com")
      expect(spec.platform?.credential).toBe("ak_live_x")
    })
  })

  describe("hosted TSecBench benchmark variables", () => {
    test("BENCHMARK_BASE_URL/TOKEN alone bind a tsecbench platform", () => {
      const spec = readBootstrapSpec({
        BENCHMARK_BASE_URL: "https://tsecbench.zc.tencent.com",
        BENCHMARK_TOKEN: "bench-tok",
      })
      expect(spec.platform).toEqual({
        type: "tsecbench",
        baseUrl: "https://tsecbench.zc.tencent.com",
        credential: "bench-tok",
      })
    })

    test("AEGISX_PLATFORM_* wins over BENCHMARK_* on every field", () => {
      const spec = readBootstrapSpec({
        AEGISX_PLATFORM_TYPE: "ctfd",
        AEGISX_PLATFORM_BASE_URL: "https://ctf.example.com",
        AEGISX_PLATFORM_CREDENTIAL: "aegisx-tok",
        BENCHMARK_BASE_URL: "https://tsecbench.zc.tencent.com",
        BENCHMARK_TOKEN: "bench-tok",
      })
      expect(spec.platform).toEqual({
        type: "ctfd",
        baseUrl: "https://ctf.example.com",
        credential: "aegisx-tok",
      })
    })

    test("BENCHMARK_TOKEN without a base URL binds nothing", () => {
      expect(
        readBootstrapSpec({ BENCHMARK_TOKEN: "bench-tok" }).platform
      ).toBeUndefined()
    })
  })
})

function makeConfigStore() {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-bootstrap-"))
  return {
    configStore: createConfigStore(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("ensureProvider", () => {
  test("creates provider + model and sets the default model ref", () => {
    const t = makeConfigStore()
    try {
      const ref = ensureProvider(t.configStore, {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible",
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "my-model",
        },
      })
      expect(ref).toBe("aegisx-bootstrap-provider/my-model")
      const provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Bootstrap")
      expect(provider?.apiKey).toBe("sk-1")
      expect(provider?.models[0]?.modelId).toBe("my-model")
      expect(provider?.models[0]?.metadataSource).toBe("bootstrap")
      expect(t.configStore.getSettings()["agent.defaultModelRef"]).toBe(ref)
    } finally {
      t.cleanup()
    }
  })

  test("exact-endpoint flag: env wins at creation and on re-bootstrap merge", () => {
    const t = makeConfigStore()
    try {
      const base = {
        label: "Bootstrap",
        type: "openai-responses" as const,
        baseUrl: "https://gw/proxy/e/token",
        apiKey: "sk-1",
        modelId: "m1",
      }
      ensureProvider(t.configStore, {
        provider: { ...base, exactEndpoint: true },
      })
      const stored = () =>
        t.configStore.getProviders().find((p) => p.label === "Bootstrap")
      expect(stored()?.exactEndpoint).toBe(true)

      // Re-bootstrap without the env var keeps the stored flag (merge, never
      // clobber — same semantics as the other deploy-time fields).
      ensureProvider(t.configStore, { provider: { ...base } })
      expect(stored()?.exactEndpoint).toBe(true)

      // A deployment that drops the flag (exact-endpoint gateway replaced by
      // a normal one) must be able to clear it explicitly.
      ensureProvider(t.configStore, {
        provider: { ...base, exactEndpoint: false },
      })
      expect(stored()?.exactEndpoint).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  test("builtin catalog model gets provenance metadata", () => {
    const t = makeConfigStore()
    try {
      ensureProvider(t.configStore, {
        provider: {
          label: "Bootstrap",
          type: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          apiKey: "k",
          modelId: "claude-sonnet-4-5",
        },
      })
      const provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Bootstrap")
      expect(provider?.models[0]?.metadataSource).toBe(
        "pi:anthropic/claude-sonnet-4-5"
      )
    } finally {
      t.cleanup()
    }
  })

  test("effort infers a reasoning fallback; resolved metadata wins", () => {
    const t = makeConfigStore()
    try {
      ensureProvider(t.configStore, {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible",
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "my-model",
          effort: "high",
        },
      })
      let provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Bootstrap")
      const inferred = JSON.parse(provider?.models[0]?.metadata ?? "{}")
      expect(inferred.reasoning).toBe(true)
      expect(inferred.thinkingLevelMap).toEqual({})
      expect(provider?.models[0]?.metadataSource).toBe("bootstrap")

      ensureProvider(t.configStore, {
        provider: {
          label: "Override",
          type: "openai-compatible",
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "other-model",
          modelMetadata: {
            metadata: { ...inferred, contextWindow: 200_000 },
            source: "custom",
          },
        },
      })
      provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Override")
      expect(provider?.models[0]?.metadataSource).toBe("custom")
      expect(
        JSON.parse(provider?.models[0]?.metadata ?? "{}").contextWindow
      ).toBe(200_000)
    } finally {
      t.cleanup()
    }
  })

  test("idempotent rerun writes nothing; user edits survive", () => {
    const t = makeConfigStore()
    try {
      const spec = {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible" as const,
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "m1",
        },
      }
      ensureProvider(t.configStore, spec)
      const version = t.configStore.configVersion
      ensureProvider(t.configStore, spec)
      expect(t.configStore.configVersion).toBe(version)

      // A UI-entered apiKey must not be reset to the env value.
      t.configStore.updateProviders(
        t.configStore
          .getProviders()
          .map((p) =>
            p.label === "Bootstrap" ? { ...p, apiKey: "sk-user" } : p
          )
      )
      const edited = t.configStore.configVersion
      ensureProvider(t.configStore, spec)
      expect(t.configStore.configVersion).toBe(edited)
      const provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Bootstrap")
      expect(provider?.apiKey).toBe("sk-user")
      expect(provider?.models.map((m) => m.modelId)).toEqual(["m1"])
    } finally {
      t.cleanup()
    }
  })

  test("empty fields are filled from env on an existing provider", () => {
    const t = makeConfigStore()
    try {
      t.configStore.updateProviders([
        {
          id: "mine",
          label: "Bootstrap",
          type: "openai-compatible",
          baseUrl: "",
          exactEndpoint: false,
          apiKey: "",
          enabled: true,
          models: [],
        },
      ])
      const ref = ensureProvider(t.configStore, {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible",
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "m1",
        },
      })
      const provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Bootstrap")
      expect(provider?.id).toBe("mine")
      expect(provider?.baseUrl).toBe("http://gw:8080/v1")
      expect(provider?.apiKey).toBe("sk-1")
      // This run contributed the model, so the unclaimed default slot seeds.
      expect(ref).toBe("aegisx-mine/m1")
      expect(t.configStore.getSettings()["agent.defaultModelRef"]).toBe(ref)
    } finally {
      t.cleanup()
    }
  })

  test("cleared default model ref stays cleared on re-bootstrap", () => {
    const t = makeConfigStore()
    try {
      const spec = {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible" as const,
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "m1",
        },
      }
      ensureProvider(t.configStore, spec)
      t.configStore.updateSettings({ "agent.defaultModelRef": null })
      const version = t.configStore.configVersion
      ensureProvider(t.configStore, spec)
      expect(t.configStore.configVersion).toBe(version)
      expect(t.configStore.getSettings()["agent.defaultModelRef"]).toBeNull()
    } finally {
      t.cleanup()
    }
  })

  test("env drift adds a new model without clobbering user fields", () => {
    const t = makeConfigStore()
    try {
      const base = {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible" as const,
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "m1",
        },
      }
      ensureProvider(t.configStore, base)
      t.configStore.updateProviders(
        t.configStore
          .getProviders()
          .map((p) =>
            p.label === "Bootstrap" ? { ...p, apiKey: "sk-user" } : p
          )
      )
      const ref = ensureProvider(t.configStore, {
        ...base,
        provider: { ...base.provider, modelId: "m2" },
      })
      expect(ref).toBe("aegisx-bootstrap-provider/m2")
      const provider = t.configStore
        .getProviders()
        .find((p) => p.label === "Bootstrap")
      expect(provider?.apiKey).toBe("sk-user")
      expect(provider?.models.map((m) => m.modelId)).toEqual(["m1", "m2"])
    } finally {
      t.cleanup()
    }
  })

  test("effort is appended to the default model ref", () => {
    const t = makeConfigStore()
    try {
      const ref = ensureProvider(t.configStore, {
        provider: {
          label: "Bootstrap",
          type: "openai-compatible",
          baseUrl: "http://gw:8080/v1",
          apiKey: "sk-1",
          modelId: "m1",
          effort: "high",
        },
      })
      expect(ref).toBe("aegisx-bootstrap-provider/m1:high")
    } finally {
      t.cleanup()
    }
  })
})

describe("bootstrap event preset", () => {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-preset-test-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("missing preset file reads as null", () => {
    expect(readEventPreset(join(dir, "absent.json"))).toBeNull()
  })

  test("malformed preset is skipped, not thrown", () => {
    const path = join(dir, "broken.json")
    writeFileSync(path, "{ not json")
    expect(readEventPreset(path)).toBeNull()
  })

  test("preset settings converge onto the store (drift-only writes)", () => {
    const settings: Record<string, string | number | boolean> = {
      "scheduler.defaultRunTimeoutMs": 3_600_000,
      "scheduler.maxConcurrentAgents": 4,
    }
    const store = fakeConfigStore(settings)
    const preset: EventPreset = {
      settings: {
        "scheduler.defaultRunTimeoutMs": 1_800_000,
        "scheduler.maxConcurrentAgents": 4,
      },
    }
    ensurePresetSettings(store, preset)
    expect(settings["scheduler.defaultRunTimeoutMs"]).toBe(1_800_000)
  })

  test("runBootstrap applies the manifest brief and scheduler policy on first boot", async () => {
    const dbh = setupDb()
    try {
      const presetPath = join(dir, "tsec.json")
      writeFileSync(
        presetPath,
        JSON.stringify({
          brief: { common: "平台：TSecBench", orchestrator: "先快题建底盘" },
          flagFormats: ["flag{<uuid>}"],
          settings: { "scheduler.defaultRunTimeoutMs": 1_800_000 },
          scheduler: { maxConcurrentTargets: 3, stopSubmitterOnSolve: true },
        })
      )
      const settings: Record<string, string | number | boolean> = {}
      const applied: Array<Record<string, unknown>> = []
      const deps: BootstrapDeps = {
        db: dbh.db,
        configStore: fakeConfigStore(settings),
        platformService: refine<BootstrapDeps["platformService"]>({}),
        agentService: fakeAgentService(applied),
        presetPath,
      }
      await runBootstrap(
        deps,
        readBootstrapSpec({ AEGISX_EVENT_NAME: "preset-evt" })
      )

      const event = dbh.db
        .select()
        .from(events)
        .all()
        .find((e) => e.name === "preset-evt")
      expect(parseEventPromptBrief(event?.promptBrief ?? "")).toEqual({
        common: "平台：TSecBench",
        solver: "",
        orchestrator: "先快题建底盘",
        flagFormats: ["flag{<uuid>}"],
      })
      expect(settings["scheduler.defaultRunTimeoutMs"]).toBe(1_800_000)
      expect(applied).toHaveLength(1)
      expect(applied[0].maxConcurrentTargets).toBe(3)
      expect(applied[0].stopSubmitterOnSolve).toBe(true)
    } finally {
      dbh.close()
    }
  })

  test("re-bootstrap backfills an empty brief but never overwrites a set one", async () => {
    const dbh = setupDb()
    try {
      const presetPath = join(dir, "hint.json")
      writeFileSync(
        presetPath,
        JSON.stringify({ brief: { common: "v2 简报" } })
      )
      const deps: BootstrapDeps = {
        db: dbh.db,
        configStore: fakeConfigStore({}),
        platformService: refine<BootstrapDeps["platformService"]>({}),
        agentService: fakeAgentService([]),
        presetPath,
      }
      const spec = readBootstrapSpec({ AEGISX_EVENT_NAME: "hint-evt" })
      await runBootstrap(deps, spec)
      // User (or an older image) set a brief afterwards — the manifest must
      // not clobber it on the next boot.
      dbh.db
        .update(events)
        .set({
          promptBrief: JSON.stringify({
            common: "用户改过的简报",
            solver: "",
            orchestrator: "",
            flagFormats: [],
          }),
        })
        .where(eq(events.name, "hint-evt"))
        .run()
      await runBootstrap(deps, spec)
      const event = dbh.db
        .select()
        .from(events)
        .all()
        .find((e) => e.name === "hint-evt")
      expect(parseEventPromptBrief(event?.promptBrief ?? "").common).toBe(
        "用户改过的简报"
      )
    } finally {
      dbh.close()
    }
  })

  test("re-bootstrap backfills manifest flagFormats even when the brief text is set", async () => {
    const dbh = setupDb()
    try {
      const presetPath = join(dir, "fmt.json")
      writeFileSync(
        presetPath,
        JSON.stringify({ brief: { common: "v1 简报" } })
      )
      const deps: BootstrapDeps = {
        db: dbh.db,
        configStore: fakeConfigStore({}),
        platformService: refine<BootstrapDeps["platformService"]>({}),
        agentService: fakeAgentService([]),
        presetPath,
      }
      const spec = readBootstrapSpec({ AEGISX_EVENT_NAME: "fmt-evt" })
      await runBootstrap(deps, spec)
      // A rebuilt image's manifest adds flagFormats — the user's text stays,
      // the manifest-only formats backfill (they are never UI-editable).
      writeFileSync(
        presetPath,
        JSON.stringify({
          brief: { common: "v2 简报" },
          flagFormats: ["flag{<uuid>}"],
        })
      )
      await runBootstrap(deps, spec)
      const event = dbh.db
        .select()
        .from(events)
        .all()
        .find((e) => e.name === "fmt-evt")
      const brief = parseEventPromptBrief(event?.promptBrief ?? "")
      expect(brief.common).toBe("v1 简报")
      expect(brief.flagFormats).toEqual(["flag{<uuid>}"])
    } finally {
      dbh.close()
    }
  })
})

/** A platform-bound event plus a sync double: challenges named in `flaky`
 * fail their first N appearances (the 429-storm shape); records the remoteIds
 * of each sync call. */
function syncStub(
  items: Array<{ id: string; imported: boolean }>,
  flaky: Record<string, number> = {}
) {
  const calls: string[][] = []
  const seen: Record<string, number> = {}
  const platformService = refine<BootstrapDeps["platformService"]>({
    discoverChallenges: async () => ({
      syncedAt: now(),
      items: items.map((item) => ({
        id: item.id,
        name: `ch-${item.id}`,
        category: null,
        points: null,
        solved: false,
        imported: item.imported,
        localChallengeId: null,
      })),
    }),
    syncChallenges: async (_eventId: string, remoteIds: string[]) => {
      calls.push([...remoteIds])
      return {
        syncedAt: now(),
        results: remoteIds.map((remoteId) => {
          seen[remoteId] = (seen[remoteId] ?? 0) + 1
          return (seen[remoteId] ?? 0) <= (flaky[remoteId] ?? 0)
            ? { remoteId, status: "failed", error: "rate limited" }
            : {
                remoteId,
                challengeId: `c-${remoteId}`,
                status: "created",
                name: `ch-${remoteId}`,
                category: null,
                points: null,
                attachments: [],
              }
        }),
      }
    },
  })
  return { platformService, calls }
}

function seedBoundEvent(db: BootstrapDeps["db"], name: string) {
  const id = crypto.randomUUID()
  const ts = now()
  db.insert(events)
    .values({ id, name, promptBrief: "", createdAt: ts, updatedAt: ts })
    .run()
  db.insert(eventPlatforms)
    .values({
      eventId: id,
      type: "dasctf",
      baseUrl: "https://plat.example.com",
      credential: "k",
      remoteEventId: "",
      sourceKey: "dasctf:match",
      createdAt: ts,
      updatedAt: ts,
    })
    .run()
  return id
}

describe("bootstrap challenge sync convergence", () => {
  test("re-pulls only the failed set until it lands", async () => {
    const dbh = setupDb()
    try {
      const eventId = seedBoundEvent(dbh.db, "sync-evt")
      const { platformService, calls } = syncStub(
        [
          { id: "1", imported: false },
          { id: "2", imported: false },
          { id: "3", imported: true },
        ],
        { "1": 1 }
      )
      await syncChallenges(
        refine<BootstrapDeps>({ db: dbh.db, platformService }),
        eventId,
        [1, 1]
      )
      expect(calls).toEqual([["1", "2"], ["1"]])
    } finally {
      dbh.close()
    }
  })

  test("gives up after the bounded rounds without throwing", async () => {
    const dbh = setupDb()
    try {
      const eventId = seedBoundEvent(dbh.db, "sync-stuck")
      const { platformService, calls } = syncStub(
        [{ id: "1", imported: false }],
        { "1": 99 }
      )
      await syncChallenges(
        refine<BootstrapDeps>({ db: dbh.db, platformService }),
        eventId,
        [1, 1]
      )
      expect(calls.length).toBe(3) // initial pass + one round per injected delay
    } finally {
      dbh.close()
    }
  })

  test("a clean first pass runs exactly one round", async () => {
    const dbh = setupDb()
    try {
      const eventId = seedBoundEvent(dbh.db, "sync-clean")
      const { platformService, calls } = syncStub([
        { id: "1", imported: false },
      ])
      await syncChallenges(
        refine<BootstrapDeps>({ db: dbh.db, platformService }),
        eventId,
        [1, 1]
      )
      expect(calls).toEqual([["1"]])
    } finally {
      dbh.close()
    }
  })
})
