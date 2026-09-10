import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureProvider, readBootstrapSpec } from "./bootstrap"
import { createConfigStore } from "./infrastructure/config-store"

function specFrom(env: Record<string, string | undefined>) {
  const spec = readBootstrapSpec(env)
  return { spec, provider: spec.provider }
}

describe("readBootstrapSpec", () => {
  test("parses a full appliance env", () => {
    const { spec } = specFrom({
      AEGISX_PROVIDER_TYPE: "openai-responses",
      AEGISX_PROVIDER_BASE_URL: "http://10.0.0.8:8080/v1",
      AEGISX_PROVIDER_API_KEY: "sk-test",
      AEGISX_PROVIDER_LABEL: "Gateway",
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
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-bootstrap-"))
  return {
    configStore: createConfigStore(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("ensureProvider", () => {
  test("creates provider + model and sets the default model ref", () => {
    const t = store()
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

  test("builtin catalog model gets provenance metadata", () => {
    const t = store()
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
    const t = store()
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
    const t = store()
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
    const t = store()
    try {
      t.configStore.updateProviders([
        {
          id: "mine",
          label: "Bootstrap",
          type: "openai-compatible",
          baseUrl: "",
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
    const t = store()
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
    const t = store()
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
    const t = store()
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
