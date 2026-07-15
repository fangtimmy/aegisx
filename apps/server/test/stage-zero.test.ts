import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat"
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const tempDirs: string[] = []
const fauxProviders: Array<{ unregister(): void }> = []

afterEach(() => {
  for (const provider of fauxProviders.splice(0)) provider.unregister()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function makeTempDir(name: string) {
  const path = mkdtempSync(join(tmpdir(), `aegisx-${name}-`))
  tempDirs.push(path)
  return path
}

async function waitFor(check: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state")
    await Bun.sleep(20)
  }
}

function runDocker(...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["docker", ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim())
  }
  return new TextDecoder().decode(result.stdout).trim()
}

describe("stage zero", () => {
  test("Pi runs finish_run, emits events, and persists JSONL", async () => {
    const root = makeTempDir("pi")
    const cwd = join(root, "workspace")
    const sessionDir = join(root, "sessions")
    const agentDir = join(root, "agent")
    mkdirSync(cwd)
    mkdirSync(sessionDir)
    mkdirSync(agentDir)

    const faux = registerFauxProvider()
    fauxProviders.push(faux)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("finish_run", {
          summary: "Solved in the stage-zero smoke test",
          flag: "flag{stage_zero}",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Finished."),
    ])

    let completion: { summary: string; flag?: string } | undefined
    const finishRun = defineTool({
      name: "finish_run",
      label: "Finish run",
      description: "Report that the challenge run is complete",
      parameters: Type.Object({
        summary: Type.String(),
        flag: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        completion = params
        return {
          content: [{ type: "text", text: "Run completed" }],
          details: {},
        }
      },
    })

    const sessionManager = SessionManager.create(cwd, sessionDir)
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"))
    authStorage.setRuntimeApiKey("faux", "stage-zero")
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      model: faux.getModel(),
      noTools: "builtin",
      customTools: [finishRun],
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
    })
    const events: string[] = []
    session.subscribe((event) => events.push(event.type))

    await session.prompt("Solve the challenge and call finish_run.")

    expect(completion).toEqual({
      summary: "Solved in the stage-zero smoke test",
      flag: "flag{stage_zero}",
    })
    expect(events).toContain("tool_execution_start")
    expect(events).toContain("tool_execution_end")
    expect(session.agent.state.tools.map((tool) => tool.name)).toEqual([
      "finish_run",
    ])

    const sessionFile = sessionManager.getSessionFile()
    session.dispose()
    expect(sessionFile).toBeDefined()
    expect(existsSync(sessionFile as string)).toBe(true)

    const reopened = SessionManager.open(sessionFile as string)
    expect(
      reopened
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "finish_run" &&
            entry.message.content.some(
              (content) =>
                content.type === "text" && content.text === "Run completed"
            )
        )
    ).toBe(true)
  })

  test("Pi abort terminates the local bash process tree", async () => {
    const root = makeTempDir("abort")
    const cwd = join(root, "workspace")
    const agentDir = join(root, "agent")
    mkdirSync(cwd)
    mkdirSync(agentDir)

    const faux = registerFauxProvider()
    fauxProviders.push(faux)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command:
            'sleep 30 & child=$!; printf "%s" "$child" > child.pid; wait "$child"',
        }),
        { stopReason: "toolUse" }
      ),
    ])

    const authStorage = AuthStorage.create(join(agentDir, "auth.json"))
    authStorage.setRuntimeApiKey("faux", "stage-zero")
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      model: faux.getModel(),
      tools: ["bash"],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    })
    let started!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") started()
    })

    const prompting = session.prompt("Run the long command.")
    await toolStarted
    const pidFile = join(cwd, "child.pid")
    await waitFor(() => existsSync(pidFile))
    const childPid = Number(readFileSync(pidFile, "utf8"))

    await session.abort()
    await prompting
    await waitFor(() => {
      try {
        process.kill(childPid, 0)
        return false
      } catch {
        return true
      }
    })
    session.dispose()
  })

  test("Pi container tools expose only the run workspace", async () => {
    const root = makeTempDir("docker")
    const workspace = join(root, "workspace")
    const hostData = join(root, "host-data")
    mkdirSync(workspace)
    mkdirSync(hostData)
    writeFileSync(join(workspace, "attachment.txt"), "challenge attachment")
    writeFileSync(join(hostData, "secret.txt"), "host secret")

    const container = `aegisx-stage-zero-${crypto.randomUUID()}`
    try {
      runDocker(
        "create",
        "--name",
        container,
        "--network",
        "bridge",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        "alpine:3.22",
        "sleep",
        "30"
      )
      runDocker("start", container)

      runDocker("exec", container, "test", "-f", "/workspace/attachment.txt")
      runDocker("exec", container, "test", "!", "-e", hostData)
      runDocker("exec", container, "test", "!", "-e", "/var/run/docker.sock")

      let readResult = ""
      let bashResult = ""
      const read = defineTool({
        name: "read",
        label: "Read",
        description: "Read a file in the container workspace",
        parameters: Type.Object({ path: Type.String() }),
        execute: async (_id, params) => {
          readResult = runDocker("exec", container, "cat", params.path)
          return {
            content: [{ type: "text", text: readResult }],
            details: {},
          }
        },
      })
      const write = defineTool({
        name: "write",
        label: "Write",
        description: "Write a file in the container workspace",
        parameters: Type.Object({
          path: Type.String(),
          content: Type.String(),
        }),
        execute: async (_id, params) => {
          runDocker(
            "exec",
            container,
            "sh",
            "-c",
            'printf "%s" "$2" > "$1"',
            "aegisx-write",
            params.path,
            params.content
          )
          return { content: [{ type: "text", text: "Written" }], details: {} }
        },
      })
      const bash = defineTool({
        name: "bash",
        label: "Bash",
        description: "Run a foreground command in the container workspace",
        parameters: Type.Object({ command: Type.String() }),
        execute: async (_id, params) => {
          bashResult = runDocker(
            "exec",
            "--workdir",
            "/workspace",
            container,
            "sh",
            "-c",
            params.command
          )
          return {
            content: [{ type: "text", text: bashResult }],
            details: {},
          }
        },
      })

      const faux = registerFauxProvider()
      fauxProviders.push(faux)
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("read", { path: "/workspace/attachment.txt" }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage(
          fauxToolCall("write", {
            path: "/workspace/result.txt",
            content: "container",
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Container checks finished."),
      ])
      const agentDir = join(root, "agent")
      mkdirSync(agentDir)
      const authStorage = AuthStorage.create(join(agentDir, "auth.json"))
      authStorage.setRuntimeApiKey("faux", "stage-zero")
      const { session } = await createAgentSession({
        cwd: workspace,
        agentDir,
        authStorage,
        model: faux.getModel(),
        noTools: "builtin",
        customTools: [read, write, bash],
        sessionManager: SessionManager.inMemory(workspace),
        settingsManager: SettingsManager.inMemory(),
      })

      expect(session.agent.state.tools.map((tool) => tool.name)).toEqual([
        "read",
        "write",
        "bash",
      ])
      await session.prompt("Inspect and update the container workspace.")
      session.dispose()

      expect(readResult).toBe("challenge attachment")
      expect(bashResult).toBe("/workspace")
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe(
        "container"
      )
    } finally {
      Bun.spawnSync({
        cmd: ["docker", "rm", "--force", container],
        stdout: "ignore",
        stderr: "ignore",
      })
    }
  }, 30_000)
})
