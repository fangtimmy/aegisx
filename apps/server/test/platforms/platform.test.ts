import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { createApp } from "../../src/app"
import { createPlatformAdapter } from "../../src/platforms/service"
import { json, waitFor } from "../support"

const roots: string[] = []
const servers: Bun.Server<unknown>[] = []
const closeApps: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeApps.splice(0)) await close()
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("CTF platform integration", () => {
  test("loads every CTFd challenge page", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const page = Number(new URL(request.url).searchParams.get("page"))
        return Response.json({
          data: [{ id: page, name: `Page ${page}` }],
          meta: {
            pagination: {
              pages: 2,
              next: page < 2 ? page + 1 : null,
            },
          },
        })
      },
    })
    servers.push(server)
    const adapter = createPlatformAdapter({
      type: "ctfd",
      baseUrl: `http://127.0.0.1:${server.port}`,
      credential: "ctfd-secret",
      remoteEventId: "site",
    })

    expect(await adapter.listChallenges()).toEqual([
      expect.objectContaining({ id: "1", name: "Page 1" }),
      expect.objectContaining({ id: "2", name: "Page 2" }),
    ])
  })

  test("discovers, syncs, preserves identity, and reconnects CTFd challenges", async () => {
    let authorization = ""
    let detailRequests = 0
    let challengeVisible = true
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization") ?? ""
        const url = new URL(request.url)
        if (url.pathname === "/api/v1/challenges") {
          return Response.json({
            data: challengeVisible
              ? [
                  {
                    id: 7,
                    name: "Remote Pwn",
                    category: "pwn",
                    value: 500,
                    solved_by_me: false,
                  },
                  {
                    id: 8,
                    name: "Broken Web",
                    category: "web",
                    value: 300,
                    solved_by_me: false,
                  },
                  {
                    id: 9,
                    name: "Broken Attachment",
                    category: "forensics",
                    value: 200,
                    solved_by_me: false,
                  },
                ]
              : [],
          })
        }
        if (url.pathname === "/api/v1/challenges/7") {
          detailRequests += 1
          return Response.json({
            data: {
              id: 7,
              name: "Remote Pwn",
              description: "Exploit it",
              category: "pwn",
              value: 500,
              solved_by_me: false,
              files: ["/files/challenge.bin?token=signed"],
            },
          })
        }
        if (url.pathname === "/api/v1/challenges/8") {
          return Response.json(
            { message: "detail unavailable" },
            { status: 500 }
          )
        }
        if (url.pathname === "/api/v1/challenges/9") {
          detailRequests += 1
          return Response.json({
            data: {
              id: 9,
              name: "Broken Attachment",
              description: "Missing file",
              category: "forensics",
              value: 200,
              solved_by_me: false,
              files: ["/files/missing.bin"],
            },
          })
        }
        if (url.pathname === "/files/challenge.bin") {
          return new Response("binary-data")
        }
        if (url.pathname === "/files/missing.bin") {
          return new Response("missing", { status: 500 })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const dataDir = mkdtempSync(join(tmpdir(), "aegisx-platform-"))
    roots.push(dataDir)
    const instance = createApp({ dataDir })
    closeApps.push(instance.close)
    const event = await (
      await instance.app.request(
        "/api/events",
        json("POST", { name: "Remote" })
      )
    ).json()

    const connect = () =>
      instance.app.request(
        `/api/events/${event.id}/platform`,
        json("PUT", {
          type: "ctfd",
          baseUrl: `http://127.0.0.1:${server.port}`,
          credential: "ctfd_secret",
          remoteEventId: "site",
        })
      )
    const bound = await connect()
    expect(bound.status).toBe(200)
    expect(authorization).toBe("Token ctfd_secret")

    const beforeImport = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(beforeImport.event.platform).toMatchObject({
      type: "ctfd",
      credential: "ctfd_secret",
      credentialConfigured: true,
    })
    expect(beforeImport.challenges).toEqual([])
    const available = await (
      await instance.app.request(
        `/api/events/${event.id}/platform/challenges/discover`,
        { method: "POST" }
      )
    ).json()
    expect(available.items[0]).toMatchObject({
      id: "7",
      name: "Remote Pwn",
      imported: false,
    })
    expect(detailRequests).toBe(0)

    const synced = await instance.app.request(
      `/api/events/${event.id}/platform/challenges/sync`,
      json("POST", { remoteIds: ["7", "8", "9"] })
    )
    expect(synced.status).toBe(200)
    expect((await synced.json()).results).toEqual([
      expect.objectContaining({ remoteId: "7", status: "created" }),
      {
        remoteId: "8",
        status: "failed",
        error: "detail unavailable",
      },
      {
        remoteId: "9",
        status: "failed",
        error: "Platform request failed (500)",
      },
    ])
    expect(detailRequests).toBe(2)
    const detail = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(detail.challenges[0]).toMatchObject({
      name: "Remote Pwn",
      remoteId: "7",
      remoteAvailable: true,
      remoteTargetCount: 0,
    })
    expect(detail.challenges).toHaveLength(1)
    const file = await instance.app.request(
      detail.challenges[0].attachments[0].downloadUrl
    )
    expect(await file.text()).toBe("binary-data")
    const challengeId = detail.challenges[0].id
    const remoteAttachment = detail.challenges[0].attachments[0]
    const edited = await instance.app.request(
      `/api/challenges/${challengeId}`,
      json("PATCH", {
        name: "Local title",
        description: "Local description",
        category: "local",
        points: 1,
      })
    )
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({
      name: "Local title",
      description: "Local description",
    })
    const localAttachment = await instance.app.request(
      `/api/challenges/${challengeId}/attachments?filename=notes.txt`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "local-notes",
      }
    )
    expect(localAttachment.status).toBe(201)
    expect(
      (
        await instance.app.request(`/api/attachments/${remoteAttachment.id}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(204)
    const refreshed = await instance.app.request(
      `/api/events/${event.id}/platform/challenges/sync`,
      json("POST", { remoteIds: ["7"] })
    )
    expect((await refreshed.json()).results[0]).toMatchObject({
      challengeId,
      status: "updated",
    })
    const afterRefresh = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(afterRefresh.challenges[0]).toMatchObject({
      name: "Remote Pwn",
      description: "Exploit it",
      category: "pwn",
      points: 500,
    })
    expect(
      afterRefresh.challenges[0].attachments.map(
        (attachment: { originalName: string }) => attachment.originalName
      )
    ).toEqual(["notes.txt", "challenge.bin"])
    const stream = await instance.app.request(
      `/api/events/${event.id}/platform/challenges/sync/stream`,
      json("POST", { remoteIds: ["7"] })
    )
    const streamed = (await stream.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(streamed).toEqual([
      expect.objectContaining({
        type: "item",
        completed: 1,
        total: 1,
        item: expect.objectContaining({ remoteId: "7", status: "updated" }),
      }),
      expect.objectContaining({ type: "complete", total: 1 }),
    ])
    const localChallenge = await instance.app.request(
      `/api/events/${event.id}/challenges`,
      json("POST", { name: "Local", description: "Local challenge" })
    )
    expect(localChallenge.status).toBe(201)

    expect(
      (
        await instance.app.request(`/api/events/${event.id}/platform`, {
          method: "DELETE",
        })
      ).status
    ).toBe(204)
    const detached = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(detached.event.platform).toBeNull()
    expect(detached.challenges[0]).toMatchObject({
      id: challengeId,
      remoteId: "7",
      remoteAvailable: false,
    })
    expect(detached.challenges[1]).toMatchObject({
      name: "Local",
      remoteId: null,
      remoteAvailable: true,
    })

    challengeVisible = false
    expect((await connect()).status).toBe(200)
    challengeVisible = true
    const reconnected = await instance.app.request(
      `/api/events/${event.id}/platform/challenges/sync`,
      json("POST", { remoteIds: ["7"] })
    )
    expect((await reconnected.json()).results[0]).toMatchObject({
      challengeId,
      status: "updated",
    })

    challengeVisible = false
    await instance.app.request(
      `/api/events/${event.id}/platform/challenges/discover`,
      { method: "POST" }
    )
    const unavailable = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(unavailable.challenges[0]).toMatchObject({
      id: challengeId,
      remoteAvailable: false,
    })
  })

  test("lets the main agent explicitly manage targets and submit flags", async () => {
    let targetState: "absent" | "starting" | "running" = "absent"
    let startPolls = 0
    let targetReads = 0
    const actions: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/game") {
          return Response.json([[{ id: 3, name: "Target event" }], 1])
        }
        if (url.pathname === "/api/game/3/challenge") {
          return Response.json([
            [{ id: 9, name: "Target task", score: 500, solved: false }],
            1,
          ])
        }
        if (url.pathname === "/api/game/3/challenge/9") {
          return Response.json({
            id: 9,
            name: "Target task",
            content: "Manage the target",
            score: 500,
            tag: [{ name: "PWN", primary: true }],
          })
        }
        if (url.pathname === "/api/game/3/challenge/9/file") {
          return Response.json([])
        }
        if (url.pathname === "/api/game/3/challenge/9/env") {
          return Response.json({ images: [{ name: "service" }] })
        }
        if (url.pathname === "/api/game/3/challenge/9/submit") {
          if (request.method !== "POST") {
            return Response.json({ solved: false })
          }
          const body = (await request.json()) as { content?: string }
          const solved = body.content === "flag{target}"
          return Response.json({
            id: 1,
            solved,
            result: solved ? "accepted" : "rejected",
          })
        }
        if (url.pathname === "/api/game/3/instance") {
          targetReads += 1
          if (targetState === "absent") return Response.json([])
          if (targetState === "starting") {
            startPolls += 1
            if (startPolls > 1) targetState = "running"
          }
          return Response.json([
            {
              challenge_id: 9,
              state: targetState === "running" ? "Running" : "Pending",
              exposed_ports:
                targetState === "running"
                  ? [{ name: "pwn", address: "target.test:31337" }]
                  : [],
            },
          ])
        }
        if (url.pathname === "/api/game/3/challenge/9/instance") {
          if (request.method === "POST") {
            actions.push("start")
            targetState = "starting"
            startPolls = 0
          } else if (request.method === "PATCH") {
            actions.push("extend")
          } else if (request.method === "DELETE") {
            actions.push("stop")
            targetState = "absent"
          }
          return new Response(null, { status: 204 })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const dataDir = mkdtempSync(join(tmpdir(), "aegisx-target-tools-"))
    roots.push(dataDir)
    const faux = fauxProvider({ models: [{ id: "faux-target" }] })
    const models = createModels()
    models.setProvider(faux.provider)
    const instance = createApp({
      dataDir,
      models,
      resolveModel: (_provider, modelId) =>
        modelId === "faux-target" ? (faux.getModel() as never) : undefined,
    })
    closeApps.push(instance.close)
    const event = await (
      await instance.app.request(
        "/api/events",
        json("POST", { name: "Targets" })
      )
    ).json()
    await instance.app.request(
      `/api/events/${event.id}/platform`,
      json("PUT", {
        type: "ret2shell",
        baseUrl: `http://127.0.0.1:${server.port}`,
        credential: "ret-token",
        remoteEventId: "3",
      })
    )
    await instance.app.request(
      `/api/events/${event.id}/platform/challenges/sync`,
      json("POST", { remoteIds: ["9"] })
    )
    const eventDetail = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    const challenge = eventDetail.challenges[0]

    const provider = (
      await (await instance.app.request("/api/providers")).json()
    ).items[0]
    await instance.app.request(
      `/api/providers/${provider.id}`,
      json("PATCH", {
        label: "Faux",
        type: "openai-compatible",
        baseUrl: "http://localhost:4010/v1",
        apiKey: "test-only",
        enabled: true,
      })
    )
    const model = await (
      await instance.app.request(
        `/api/providers/${provider.id}/models`,
        json("POST", { modelId: "faux-target", label: "Faux target" })
      )
    ).json()
    const createRun = () =>
      instance.app.request(
        `/api/challenges/${challenge.id}/runs`,
        json("POST", { modelId: model.id })
      )

    faux.setResponses([fauxAssistantMessage("Waiting for instructions.")])
    const firstRun = await (await createRun()).json()
    await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${firstRun.id}`)).json(),
      (detail) =>
        detail.agents.some(
          (agent: { parentAgentId: string | null; status: string }) =>
            agent.parentAgentId === null && agent.status === "idle"
        )
    )
    expect(targetReads).toBe(0)
    const inspector = await (
      await instance.app.request(
        `/api/runs/${firstRun.id}/agents/${firstRun.id}/inspector`
      )
    ).json()
    expect(
      inspector.runtime.tools.map((tool: { name: string }) => tool.name)
    ).toEqual(
      expect.arrayContaining([
        "get_target",
        "start_target",
        "extend_target",
        "stop_target",
        "submit_flag",
      ])
    )
    expect(inspector.runtime.systemPrompt).not.toContain("target.test:31337")

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("start_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("extend_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("stop_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("start_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("submit_flag", { flag: "flag{wrong}" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("submit_flag", { flag: "flag{target}" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(fauxToolCall("stop_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("finish_run", {
          summary: "Target lifecycle verified",
        }),
        { stopReason: "toolUse" }
      ),
    ])
    await instance.app.request(
      `/api/runs/${firstRun.id}/message`,
      json("POST", { message: "Manage the target and finish." })
    )
    await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${firstRun.id}`)).json(),
      (detail) => detail.run.status === "completed" && actions.length === 5
    )
    expect(actions).toEqual(["start", "extend", "stop", "start", "stop"])
    expect(String(targetState)).toBe("absent")
    const sqlite = new Database(join(dataDir, "aegisx.sqlite"))
    expect(
      sqlite
        .query(
          "select flag, status from submissions where run_id = ? order by created_at"
        )
        .all(firstRun.id)
    ).toEqual([
      { flag: "flag{wrong}", status: "rejected" },
      { flag: "flag{target}", status: "accepted" },
    ])
    sqlite.close()

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("start_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Target left running."),
    ])
    const secondRun = await (await createRun()).json()
    await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${secondRun.id}`)).json(),
      (detail) =>
        detail.agents.some(
          (agent: { parentAgentId: string | null; status: string }) =>
            agent.parentAgentId === null && agent.status === "idle"
        ) && targetState === "running"
    )
    const actionCount = actions.length
    await instance.app.request(
      `/api/runs/${secondRun.id}/pause`,
      json("POST", {})
    )
    expect(actions).toHaveLength(actionCount)
    expect(String(targetState)).toBe("running")
    await instance.app.request(
      `/api/runs/${secondRun.id}/stop`,
      json("POST", {})
    )
    expect(actions).toHaveLength(actionCount)
    expect(String(targetState)).toBe("running")
    expect(
      (
        await instance.app.request(`/api/events/${event.id}/platform`, {
          method: "DELETE",
        })
      ).status
    ).toBe(409)
    targetState = "absent"

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("start_target", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider failed",
      }),
    ])
    const failedRun = await (await createRun()).json()
    await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${failedRun.id}`)).json(),
      (detail) => detail.run.status === "failed"
    )
    expect(String(targetState)).toBe("running")
    expect(
      (
        await instance.app.request(`/api/challenges/${challenge.id}/target`, {
          method: "DELETE",
        })
      ).status
    ).toBe(409)
    targetState = "absent"
    expect(
      (
        await instance.app.request(`/api/challenges/${challenge.id}/target`, {
          method: "DELETE",
        })
      ).status
    ).toBe(204)
    await instance.app.request(
      `/api/events/${event.id}/platform/challenges/sync`,
      json("POST", { remoteIds: ["9"] })
    )
    const ignored = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(ignored.challenges[0]).toMatchObject({
      remoteTargetIgnored: true,
      remoteTargetCount: 0,
      targets: [],
    })
    faux.setResponses([fauxAssistantMessage("No target available.")])
    const ignoredRun = await (await createRun()).json()
    await waitFor(
      async () =>
        (await instance.app.request(`/api/runs/${ignoredRun.id}`)).json(),
      (detail) =>
        detail.agents.some(
          (agent: { parentAgentId: string | null; status: string }) =>
            agent.parentAgentId === null && agent.status === "idle"
        )
    )
    const ignoredInspector = await (
      await instance.app.request(
        `/api/runs/${ignoredRun.id}/agents/${ignoredRun.id}/inspector`
      )
    ).json()
    expect(ignoredRun.targetSupported).toBe(false)
    expect(
      ignoredInspector.runtime.tools.map((tool: { name: string }) => tool.name)
    ).not.toContain("start_target")
  })

  test("maps ret2shell asynchronous submissions and target endpoints", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        expect(request.headers.get("authorization")).toBe("Bearer ret-token")
        if (url.pathname.endsWith("/submit") && request.method === "POST") {
          return Response.json({ id: 11, solved: null })
        }
        if (url.pathname.endsWith("/submit")) {
          return Response.json({ id: 11, solved: true, result: "accepted" })
        }
        if (url.pathname === "/api/game/3/challenge/9") {
          return Response.json({
            id: 9,
            name: "Service task",
            content: "Connect to it",
            score: 500,
            tag: [{ name: "PWN", primary: true }],
          })
        }
        if (url.pathname === "/api/game/3/challenge/9/file") {
          return Response.json([])
        }
        if (url.pathname === "/api/game/3/challenge/9/env") {
          return Response.json({
            images: [
              {
                name: "service",
                exposed_ports: [{ name: "tcp" }],
              },
            ],
          })
        }
        if (url.pathname === "/api/game/3/instance") {
          return Response.json([
            {
              challenge_id: 9,
              state: "Running",
              traffic: "traffic-token",
              ports: [5000],
              exposed_ports: null,
            },
          ])
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const adapter = createPlatformAdapter({
      type: "ret2shell",
      baseUrl: `http://127.0.0.1:${server.port}`,
      credential: "ret-token",
      remoteEventId: "3",
    })
    const submitted = await adapter.submitFlag("9", "flag{ok}")
    expect(submitted).toEqual({ status: "pending", remoteId: "11" })
    expect(await adapter.getSubmission?.("9", "11")).toMatchObject({
      status: "accepted",
    })
    expect(await adapter.getTarget?.("9")).toMatchObject({
      status: "running",
      endpoints: [
        {
          name: "port 5000",
          protocol: "ws",
          address: `ws://127.0.0.1:${server.port}/api/traffic/traffic-token?port=5000`,
          guidance: expect.arrayContaining([
            expect.stringContaining("wsrx connect"),
            expect.stringContaining("127.0.0.1:<local-port>"),
          ]),
        },
      ],
    })
    expect(await adapter.getChallenge("9")).toMatchObject({
      targetCount: 1,
      targets: [{ name: "service", services: ["tcp"] }],
    })
  })

  test("uses the A1CTF cookie and maps queued judging", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(request.headers.get("cookie")).toBe("a1token=a1-secret")
        const url = new URL(request.url)
        if (request.method === "POST") {
          return Response.json({ code: 200, data: { judge_id: "judge-1" } })
        }
        if (url.pathname.endsWith("/judge-1")) {
          return Response.json({
            code: 200,
            data: { judge_id: "judge-1", judge_status: "JudgeRunning" },
          })
        }
        if (url.pathname.endsWith("/challenge/8")) {
          return Response.json({
            code: 200,
            data: {
              challenge_id: 8,
              challenge_name: "Container task",
              description: "Run it",
              category: "PWN",
              cur_score: 500,
              attachments: [],
              container_type: "DYNAMIC_CONTAINER",
              containers: [
                {
                  container_name: "frontend",
                  container_ports: [{ port_name: "http" }],
                },
                { container_name: "database", container_ports: [] },
              ],
            },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const adapter = createPlatformAdapter({
      type: "a1ctf",
      baseUrl: `http://127.0.0.1:${server.port}`,
      credential: "a1-secret",
      remoteEventId: "5",
    })
    expect(await adapter.submitFlag("8", "flag{queued}")).toEqual({
      status: "pending",
      remoteId: "judge-1",
    })
    expect(await adapter.getSubmission?.("8", "judge-1")).toMatchObject({
      status: "pending",
      message: "JudgeRunning",
    })
    expect(await adapter.getChallenge("8")).toMatchObject({
      targetCount: 2,
      targets: [
        { name: "frontend", services: ["http"] },
        { name: "database", services: [] },
      ],
    })
  })
})
