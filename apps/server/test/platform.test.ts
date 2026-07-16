import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app"
import { createPlatformAdapter } from "../src/platform"
import { json } from "./support"

const roots: string[] = []
const servers: Bun.Server<unknown>[] = []
const closeApps: Array<() => void> = []

afterEach(() => {
  for (const close of closeApps.splice(0)) close()
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("CTF platform integration", () => {
  test("binds a CTFd event, imports files, and detaches to manual data", async () => {
    let authorization = ""
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? ""
        const url = new URL(request.url)
        if (url.pathname === "/api/v1/challenges") {
          return Response.json({ data: [{ id: 7 }] })
        }
        if (url.pathname === "/api/v1/challenges/7") {
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
        if (url.pathname === "/files/challenge.bin") {
          return new Response("binary-data")
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

    const bound = await instance.app.request(
      `/api/events/${event.id}/platform/bind`,
      json("POST", {
        type: "ctfd",
        baseUrl: `http://127.0.0.1:${server.port}`,
        credential: "ctfd_secret",
        remoteEventId: "site",
      })
    )
    expect(bound.status).toBe(200)
    expect(authorization).toBe("Token ctfd_secret")

    const beforeImport = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(beforeImport.event).toMatchObject({
      platformType: "ctfd",
      platformCredentialConfigured: true,
    })
    expect(beforeImport.challenges).toEqual([])
    expect(JSON.stringify(beforeImport)).not.toContain("ctfd_secret")
    const available = await (
      await instance.app.request(`/api/events/${event.id}/platform/challenges`)
    ).json()
    expect(available.items).toEqual([
      {
        id: "7",
        name: "Remote Pwn",
        category: "pwn",
        points: 500,
        solved: false,
      },
    ])

    const imported = await instance.app.request(
      `/api/events/${event.id}/platform/import`,
      json("POST", { remoteIds: ["7"] })
    )
    expect(imported.status).toBe(200)
    const detail = await (
      await instance.app.request(`/api/events/${event.id}`)
    ).json()
    expect(detail.challenges[0]).toMatchObject({
      name: "Remote Pwn",
      remoteId: "7",
    })
    const file = await instance.app.request(
      detail.challenges[0].attachments[0].downloadUrl
    )
    expect(await file.text()).toBe("binary-data")
    expect(
      (
        await instance.app.request(
          `/api/events/${event.id}/challenges`,
          json("POST", { name: "Local", description: "Blocked" })
        )
      ).status
    ).toBe(409)

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
    expect(detached.event.platformType).toBeNull()
    expect(detached.challenges[0].remoteId).toBeNull()
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
        if (url.pathname === "/api/game/3/instance") {
          return Response.json([
            {
              challenge_id: 9,
              state: "Running",
              exposed_ports: [{ name: "web", address: "https://target.test" }],
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
      endpoints: [{ protocol: "https", address: "https://target.test" }],
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
  })
})
