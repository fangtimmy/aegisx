import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { createApp } from "../../src/app"
import { waitFor } from "../support"

const roots: string[] = []
const closeApps: Array<() => void | Promise<void>> = []
const configuredModels = new WeakMap<object, Promise<string>>()

afterEach(async () => {
  for (const close of closeApps.splice(0)) await close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "aegisx-container-"))
  roots.push(dataDir)
  const faux = fauxProvider({ models: [{ id: "faux-1" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const instance = createApp({
    dataDir,
    models,
    resolveModel: (_provider, modelId) =>
      modelId === faux.getModel().id ? (faux.getModel() as never) : undefined,
  })
  closeApps.push(instance.close)
  return { ...instance, dataDir, faux }
}

function json(body: object) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function createChallenge(app: ReturnType<typeof createApp>["app"]) {
  const event = await (
    await app.request("/api/events", json({ name: "Container tests" }))
  ).json()
  return (
    await app.request(
      `/api/events/${event.id}/challenges`,
      json({ name: "Sandbox", description: "Inspect the workspace" })
    )
  ).json()
}

function docker(...args: string[]) {
  return Bun.spawnSync({
    cmd: ["docker", ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
}

function configureFaux(app: ReturnType<typeof createApp>["app"]) {
  const cached = configuredModels.get(app)
  if (cached) return cached
  const configured = (async () => {
    const providers = await (await app.request("/api/providers")).json()
    const provider = providers.items[0]
    await app.request(`/api/providers/${provider.id}`, {
      ...json({
        label: "Faux",
        type: "openai-compatible",
        baseUrl: "http://localhost:4011/v1",
        apiKey: "host-only-secret",
        enabled: true,
      }),
      method: "PATCH",
    })
    const model = await (
      await app.request(
        `/api/providers/${provider.id}/models`,
        json({ modelId: "faux-1", label: "Faux 1" })
      )
    ).json()
    return model.id as string
  })()
  configuredModels.set(app, configured)
  return configured
}

describe("container execution and workspace files", () => {
  test("browses and downloads workspace files without crossing its real path", async () => {
    const instance = setup()
    const challenge = await createChallenge(instance.app)
    instance.faux.setResponses([fauxAssistantMessage("Waiting for guidance.")])
    const modelId = await configureFaux(instance.app)
    const run = await (
      await instance.app.request(
        `/api/challenges/${challenge.id}/runs`,
        json({ modelId, environment: "local" })
      )
    ).json()
    const workspace = join(instance.dataDir, "workspaces", run.id)
    mkdirSync(join(workspace, "notes"))
    writeFileSync(
      join(workspace, "notes", "solution.txt"),
      "line one\nline two"
    )
    writeFileSync(join(workspace, "evidence.bin"), new Uint8Array([0, 1, 2, 3]))
    const outside = join(instance.dataDir, "outside.txt")
    writeFileSync(outside, "host data")
    symlinkSync(outside, join(workspace, "outside-link"))

    const root = await (
      await instance.app.request(`/api/runs/${run.id}/files`)
    ).json()
    expect(root).toMatchObject({ path: "", type: "directory" })
    expect(root.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "notes",
      "evidence.bin",
    ])

    const text = await (
      await instance.app.request(
        `/api/runs/${run.id}/files?path=notes%2Fsolution.txt`
      )
    ).json()
    expect(text).toMatchObject({
      path: "notes/solution.txt",
      type: "text",
      content: "line one\nline two",
      truncated: false,
    })
    const binary = await (
      await instance.app.request(`/api/runs/${run.id}/files?path=evidence.bin`)
    ).json()
    expect(binary).toMatchObject({ type: "binary", size: 4 })

    const download = await instance.app.request(
      `/api/runs/${run.id}/files/download?path=notes%2Fsolution.txt`
    )
    expect(download.status).toBe(200)
    expect(await download.text()).toBe("line one\nline two")
    expect(download.headers.get("content-disposition")).toContain(
      "solution.txt"
    )

    for (const path of [
      "..%2Foutside.txt",
      "%2Fetc%2Fpasswd",
      "outside-link",
    ]) {
      const response = await instance.app.request(
        `/api/runs/${run.id}/files?path=${path}`
      )
      expect(response.status).toBe(400)
      expect(JSON.stringify(await response.json())).not.toContain(
        instance.dataDir
      )
    }
  })

  test("rejects Docker option injection through the image field", async () => {
    const instance = setup()
    const challenge = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    const response = await instance.app.request(
      `/api/challenges/${challenge.id}/runs`,
      json({
        modelId,
        environment: "container",
        image: "--privileged",
      })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    })
  })

  test("routes all environment tools into a limited container and removes it", async () => {
    const instance = setup()
    const challenge = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    await instance.app.request(
      `/api/challenges/${challenge.id}/attachments?filename=attachment.txt`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "challenge attachment",
      }
    )
    instance.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command:
            "test -f attachment.txt && test ! -e /var/run/docker.sock && printf ready > container-ready && sleep 30",
        }),
        { stopReason: "toolUse" }
      ),
    ])
    const run = await (
      await instance.app.request(
        `/api/challenges/${challenge.id}/runs`,
        json({
          modelId,
          environment: "container",
          image: "alpine:3.22",
        })
      )
    ).json()
    expect(run).toMatchObject({
      environment: "container",
      image: "alpine:3.22",
    })
    const workspace = join(instance.dataDir, "workspaces", run.id)
    await waitFor(
      async () => existsSync(join(workspace, "container-ready")),
      Boolean
    )

    const name = `aegisx-run-${run.id}`
    const inspected = docker("inspect", name)
    expect(inspected.exitCode).toBe(0)
    const config = JSON.parse(new TextDecoder().decode(inspected.stdout))[0]
    expect(config.HostConfig).toMatchObject({
      NetworkMode: "bridge",
      IpcMode: "none",
      Privileged: false,
      ReadonlyRootfs: false,
      PidsLimit: 256,
      Memory: 2_147_483_648,
      NanoCpus: 2_000_000_000,
    })
    expect(config.HostConfig.CapDrop).toEqual(["ALL"])
    expect(config.HostConfig.SecurityOpt).toContain("no-new-privileges")
    expect(config.Mounts).toHaveLength(1)
    expect(config.Mounts[0].Destination).toBe("/workspace")

    const paused = await instance.app.request(
      `/api/runs/${run.id}/pause`,
      json({})
    )
    expect((await paused.json()).status).toBe("paused")
    await waitFor(
      async () => docker("inspect", name).exitCode !== 0,
      Boolean,
      10_000
    )
    expect(instance.activeSessionCount()).toBe(0)

    instance.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "/etc/passwd" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "sleep 5", timeout: 0.1 }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "printf recovered > timeout-recovered",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "result.txt", content: "first" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("edit", {
          path: "result.txt",
          edits: [{ oldText: "first", newText: "container" }],
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("grep", { pattern: "container", path: "." }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(fauxToolCall("find", { pattern: "*.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("ls", { path: "." }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("finish_run", { summary: "Container tools verified" }),
        { stopReason: "toolUse" }
      ),
    ])
    await instance.app.request(
      `/api/runs/${run.id}/resume`,
      json({ message: "Verify every container tool." })
    )
    const completed = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          run: { status: string; summary: string | null }
          messages: unknown[]
        }>,
      (detail) => detail.run.status === "completed"
    )
    expect(completed.run.summary).toBe("Container tools verified")
    const completedMessages = await (
      await instance.app.request(
        `/api/runs/${run.id}/messages?agentId=${encodeURIComponent(String(completed.run.mainAgentId ?? run.mainAgentId))}`
      )
    ).json()
    expect(JSON.stringify(completedMessages)).toContain(
      "Container tools verified"
    )
    expect(JSON.stringify(completedMessages)).not.toContain("host-only-secret")
    expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe(
      "container"
    )
    expect(readFileSync(join(workspace, "timeout-recovered"), "utf8")).toBe(
      "recovered"
    )
    await waitFor(
      async () => docker("inspect", name).exitCode !== 0,
      Boolean,
      10_000
    )
    expect(instance.activeSessionCount()).toBe(0)
  }, 30_000)

  test("pauses and cleans up when its container disappears", async () => {
    const instance = setup()
    const challenge = await createChallenge(instance.app)
    const modelId = await configureFaux(instance.app)
    instance.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "printf ready > container-ready && sleep 30",
        }),
        { stopReason: "toolUse" }
      ),
    ])
    const run = await (
      await instance.app.request(
        `/api/challenges/${challenge.id}/runs`,
        json({ modelId, environment: "container", image: "alpine:3.22" })
      )
    ).json()
    const workspace = join(instance.dataDir, "workspaces", run.id)
    await waitFor(
      async () => existsSync(join(workspace, "container-ready")),
      Boolean
    )

    const name = `aegisx-run-${run.id}`
    expect(docker("rm", "--force", name).exitCode).toBe(0)
    const detail = await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${run.id}`)).json() as Promise<{
          run: { status: string; error: string | null }
          agents: Array<{ status: string }>
        }>,
      (value) => value.run.status === "paused"
    )

    expect(detail.run.error).toBe("Container execution became unavailable")
    expect(detail.agents.every((agent) => agent.status === "paused")).toBe(true)
    expect(instance.activeSessionCount()).toBe(0)
    expect(docker("inspect", name).exitCode).not.toBe(0)
  }, 30_000)
})
