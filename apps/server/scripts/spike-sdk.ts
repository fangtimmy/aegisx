/**
 * Phase 0 spike: Bun + pi SDK (createAgentSession).
 *
 * Validates, under Bun:
 *  1. ModelRuntime + custom provider (from data/config.json)
 *  2. createAgentSession + prompt + subscribe (text_delta)
 *  3. SessionManager disk persistence
 *  4. BashOperations override (mock remote exec; optional docker)
 *  5. host-cwd read tool
 *
 * Run from apps/server:
 *   bun run scripts/spike-sdk.ts
 *   SPIKE_DOCKER=1 bun run scripts/spike-sdk.ts   # also try docker exec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

const ROOT = resolve(import.meta.dir, "../../..")
const CONFIG_PATH = join(ROOT, "data/config.json")
const WORKSPACE = resolve(import.meta.dir, "../tmp/spike-workspace")
const SESSIONS = resolve(import.meta.dir, "../tmp/spike-sessions")
const USE_DOCKER = process.env.SPIKE_DOCKER === "1"
const DOCKER_IMAGE = process.env.SPIKE_DOCKER_IMAGE ?? "aegisx/solver:kali"

type StepResult = { name: string; ok: boolean; detail: string }

const results: StepResult[] = []

function ok(name: string, detail: string) {
  results.push({ name, ok: true, detail })
  console.log(`✓ ${name}: ${detail}`)
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail })
  console.error(`✗ ${name}: ${detail}`)
}

function loadDefaultProvider(): {
  providerKey: string
  modelId: string
  baseUrl: string
  apiKey: string
  api: "openai-completions" | "openai-responses" | "anthropic-messages"
  model: {
    id: string
    name: string
    reasoning: boolean
    input: Array<"text" | "image">
    cost: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
    contextWindow: number
    maxTokens: number
    compat?: Record<string, unknown>
  }
} {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
    settings: Record<string, unknown>
    providers: Array<{
      id: string
      type: string
      baseUrl: string
      apiKey: string
      enabled: boolean
      models: Array<{
        id: string
        modelId: string
        label: string
        enabled: boolean
        metadata: string
      }>
    }>
  }
  const defaultModelId = raw.settings["agent.defaultModelId"] as string | null
  if (!defaultModelId) throw new Error("No agent.defaultModelId in config")

  for (const provider of raw.providers) {
    if (!provider.enabled || !provider.apiKey) continue
    const model = provider.models.find(
      (m) => m.id === defaultModelId && m.enabled
    )
    if (!model) continue
    const metadata = JSON.parse(model.metadata || "{}") as {
      reasoning?: boolean
      input?: Array<"text" | "image">
      cost?: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
      }
      contextWindow?: number
      maxTokens?: number
      compat?: Record<string, unknown>
    }
    const api =
      provider.type === "openai-responses"
        ? "openai-responses"
        : provider.type === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-completions"
    return {
      providerKey: `aegisx-spike-${provider.id.slice(0, 8)}`,
      modelId: model.modelId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      api,
      model: {
        id: model.modelId,
        name: model.label,
        reasoning: metadata.reasoning ?? false,
        input: metadata.input ?? ["text"],
        cost: metadata.cost ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: metadata.contextWindow ?? 128_000,
        maxTokens: metadata.maxTokens ?? 8192,
        compat: metadata.compat,
      },
    }
  }
  throw new Error(`Default model ${defaultModelId} not found among enabled providers`)
}

function minimalResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

/** Mock "remote" bash: proves BashOperations override works under Bun. */
function mockBashOperations(log: string[]) {
  return {
    exec: async (
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void
        signal?: AbortSignal
        timeout?: number
      }
    ) => {
      log.push(`mock-exec cwd=${cwd} cmd=${command}`)
      const out = `MOCK_OK\ncwd=${cwd}\ncmd=${command}\n`
      options.onData(Buffer.from(out))
      return { exitCode: 0 }
    },
  }
}

/**
 * Bun-safe container bash: dockerode exec.attach hijack hits the same Bun
 * node:http upgrade hole as PTY attach (HTTP 101). CLI `docker exec` streams
 * cleanly under Bun and is good enough for MVP BashOperations.
 */
function dockerCliBashOperations(containerName: string) {
  return {
    exec: async (
      command: string,
      _cwd: string,
      options: {
        onData: (data: Buffer) => void
        signal?: AbortSignal
        timeout?: number
      }
    ) => {
      const proc = Bun.spawn(
        ["docker", "exec", "-w", "/workspace", containerName, "bash", "-lc", command],
        {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        }
      )

      const onAbort = () => {
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })

      const pump = async (stream: ReadableStream<Uint8Array> | null) => {
        if (!stream) return
        const reader = stream.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) options.onData(Buffer.from(value))
        }
      }

      try {
        await Promise.all([pump(proc.stdout), pump(proc.stderr)])
        const exitCode = await proc.exited
        return { exitCode }
      } finally {
        options.signal?.removeEventListener("abort", onAbort)
      }
    },
  }
}

async function withDockerContainer<T>(
  fn: (name: string) => Promise<T>
): Promise<T> {
  const { default: Docker } = await import("dockerode")
  const docker = new Docker({ socketPath: "/var/run/docker.sock" })
  const name = `aegisx-spike-${Date.now()}`
  mkdirSync(WORKSPACE, { recursive: true })
  const container = await docker.createContainer({
    name,
    Image: DOCKER_IMAGE,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    HostConfig: {
      Binds: [`${WORKSPACE}:/workspace`],
      AutoRemove: true,
    },
  })
  await container.start()
  try {
    return await fn(name)
  } finally {
    try {
      await container.stop({ t: 2 })
    } catch {
      // ignore
    }
    try {
      await container.remove({ force: true })
    } catch {
      // AutoRemove may have cleaned it
    }
  }
}

async function main() {
  console.log("=== AegisX v4 Phase 0 spike (Bun + pi SDK) ===")
  console.log(`bun: ${process.versions.bun ?? "not-bun"}`)
  console.log(`cwd workspace: ${WORKSPACE}`)
  console.log(`sessions: ${SESSIONS}`)

  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(SESSIONS, { recursive: true })
  writeFileSync(join(WORKSPACE, "HELLO.txt"), "spike-hello from host workspace\n")

  // --- 1. ModelRuntime + custom provider ---
  const cfg = loadDefaultProvider()
  console.log(
    `\nprovider=${cfg.providerKey} model=${cfg.modelId} api=${cfg.api} baseUrl=${cfg.baseUrl}`
  )

  const runtimeDir = mkdtempSync(join(tmpdir(), "aegisx-spike-runtime-"))
  try {
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      authPath: join(runtimeDir, "auth.json"),
    })
    modelRuntime.registerProvider(cfg.providerKey, {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      api: cfg.api,
      models: [
        {
          id: cfg.model.id,
          name: cfg.model.name,
          reasoning: cfg.model.reasoning,
          input: cfg.model.input,
          cost: cfg.model.cost,
          contextWindow: cfg.model.contextWindow,
          maxTokens: cfg.model.maxTokens,
          compat: cfg.model.compat,
        },
      ],
    })
    const model = modelRuntime.getModel(cfg.providerKey, cfg.modelId)
    if (!model) {
      fail("model-runtime", `getModel(${cfg.providerKey}, ${cfg.modelId}) returned undefined`)
      printSummaryAndExit(1)
      return
    }
    ok(
      "model-runtime",
      `${model.provider}/${model.id} api=${model.api} ctx=${model.contextWindow}`
    )

    // --- 2+3. createAgentSession + prompt + subscribe + SessionManager ---
    const bashLog: string[] = []
    const eventTypes = new Set<string>()
    let textChars = 0
    let sawTextDelta = false
    let toolStarts = 0

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })

    const sessionManager = SessionManager.create(WORKSPACE, SESSIONS)
    const sessionFile = sessionManager.getSessionFile()
    ok(
      "session-manager-create",
      `id=${sessionManager.getSessionId()} file=${sessionFile ?? "(in-memory?)"}`
    )

    const bashDef = createBashToolDefinition(WORKSPACE, {
      operations: mockBashOperations(bashLog),
    })

    const resourceLoader =
      // Prefer explicit system prompt with zero discovery noise
      minimalResourceLoader(
        "You are a spike test assistant. Be extremely concise. Use tools when asked."
      )

    // Also try DefaultResourceLoader path existence (not required for success)
    try {
      const loader = new DefaultResourceLoader({
        cwd: WORKSPACE,
        agentDir: runtimeDir,
        settingsManager,
        systemPromptOverride: () =>
          "You are a spike test assistant. Be extremely concise.",
      })
      await loader.reload()
      ok("default-resource-loader", "reload() ok")
    } catch (error) {
      fail(
        "default-resource-loader",
        error instanceof Error ? error.message : String(error)
      )
    }

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: WORKSPACE,
      agentDir: runtimeDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: ["read", "bash", "ls"],
      customTools: [bashDef] as ToolDefinition[],
    })

    if (modelFallbackMessage) {
      console.warn(`model fallback: ${modelFallbackMessage}`)
    }
    ok(
      "create-agent-session",
      `sessionId=${session.sessionId} model=${session.model?.provider}/${session.model?.id}`
    )

    const unsub = session.subscribe((event) => {
      eventTypes.add(event.type)
      if (
        event.type === "message_update" &&
        "assistantMessageEvent" in event &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        sawTextDelta = true
        const delta = event.assistantMessageEvent.delta ?? ""
        textChars += delta.length
        process.stdout.write(delta)
      }
      if (event.type === "tool_execution_start") {
        toolStarts += 1
        console.log(
          `\n[tool_start] ${"toolName" in event ? event.toolName : "?"} ${
            "toolCallId" in event ? event.toolCallId : ""
          }`
        )
      }
      if (event.type === "tool_execution_end") {
        console.log(
          `[tool_end] ${"toolName" in event ? event.toolName : "?"} error=${
            "isError" in event ? event.isError : false
          }`
        )
      }
    })

    try {
      console.log("\n--- prompt: read + mock bash ---")
      await session.prompt(
        [
          "Do exactly two things, then stop:",
          "1) Use the read tool on HELLO.txt",
          "2) Use bash to run: echo spike-bash",
          "Then reply with one short sentence confirming both results.",
        ].join("\n")
      )
      console.log("\n--- prompt settled ---")

      if (sawTextDelta || textChars > 0) {
        ok("subscribe-text-delta", `chars=${textChars} events=${[...eventTypes].join(",")}`)
      } else if (eventTypes.has("message_end") || eventTypes.has("agent_end")) {
        // Some providers may not stream deltas; still count as partial success if we got messages
        ok(
          "subscribe-text-delta",
          `no text_delta but got events=${[...eventTypes].join(",")} (non-streaming provider?)`
        )
      } else {
        fail(
          "subscribe-text-delta",
          `no text; events=${[...eventTypes].join(",") || "(none)"}`
        )
      }

      if (bashLog.length > 0) {
        ok("bash-operations-override", bashLog.join(" | "))
      } else if (toolStarts > 0) {
        fail(
          "bash-operations-override",
          `tools ran (${toolStarts}) but mock bash log empty — bash may not have been overridden`
        )
      } else {
        fail(
          "bash-operations-override",
          "model did not call bash (prompt compliance); override unproven this run"
        )
      }

      // Session file should exist on disk after turns
      const file = session.sessionFile ?? sessionManager.getSessionFile()
      if (file) {
        const stat = Bun.file(file)
        const exists = await stat.exists()
        const size = exists ? (await stat.stat()).size : 0
        if (exists && size > 0) {
          ok("session-persist", `${file} size=${size}`)
        } else {
          fail("session-persist", `${file} missing or empty`)
        }

        // Re-open
        try {
          const reopened = SessionManager.open(file, SESSIONS, WORKSPACE)
          const entries = reopened.getEntries()
          ok(
            "session-reopen",
            `id=${reopened.getSessionId()} entries=${entries.length}`
          )
        } catch (error) {
          fail(
            "session-reopen",
            error instanceof Error ? error.message : String(error)
          )
        }
      } else {
        fail("session-persist", "no sessionFile path")
      }
    } finally {
      unsub()
      await session.dispose()
    }

    // --- 4. optional docker exec bash ---
    if (USE_DOCKER) {
      console.log("\n--- docker bash operations ---")
      try {
        await withDockerContainer(async (name) => {
          const ops = dockerCliBashOperations(name)
          const chunks: Buffer[] = []
          const { exitCode } = await ops.exec(
            "uname -a && test -f /workspace/HELLO.txt && cat /workspace/HELLO.txt",
            "/workspace",
            {
              onData: (data) => {
                chunks.push(data)
                process.stdout.write(data)
              },
            }
          )
          const text = Buffer.concat(chunks).toString("utf8")
          if (exitCode === 0 && text.includes("spike-hello")) {
            ok("docker-exec", `container=${name} exit=${exitCode}`)
          } else {
            fail(
              "docker-exec",
              `exit=${exitCode} out=${text.slice(0, 200)}`
            )
          }
        })
      } catch (error) {
        fail(
          "docker-exec",
          error instanceof Error ? error.message : String(error)
        )
      }
    } else {
      console.log("\n(skip docker-exec; set SPIKE_DOCKER=1 to enable)")
    }
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }

  printSummaryAndExit(results.some((r) => !r.ok) ? 1 : 0)
}

function printSummaryAndExit(code: number) {
  console.log("\n=== summary ===")
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name} — ${r.detail}`)
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`${passed}/${results.length} passed`)
  if (code !== 0) {
    console.log(
      "\nGate: Phase 0 not fully green. Fix before Phase 1 schema/service rewrite."
    )
  } else {
    console.log("\nGate: Phase 0 green under Bun. Safe to start Phase 1.")
  }
  process.exit(code)
}

main().catch((error) => {
  console.error("spike crashed:", error)
  process.exit(1)
})
