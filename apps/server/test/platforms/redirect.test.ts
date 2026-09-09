import { afterEach, describe, expect, test } from "bun:test"

import { PlatformError, PlatformHttp } from "../../src/platforms/core"
import { refine } from "../support"

type SeenRequest = {
  url: string
  headers: Record<string, string>
}

const AUTH_HEADERS = {
  "X-Agent-AccessKey": "ak_secret",
  Cookie: "session=cookie_secret",
}

let servers: { stop(): void }[] = []

function startServer(fetch: (request: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

/** Records every request's headers; always answers 200. */
function startCollector() {
  const requests: SeenRequest[] = []
  const url = startServer((request) => {
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    requests.push({ url: request.url, headers })
    return new Response("collected")
  })
  return { requests, url }
}

afterEach(() => {
  for (const server of servers) server.stop()
  servers = []
})

describe("PlatformHttp redirect policy", () => {
  test("cross-origin redirect is not followed and leaks no auth headers", async () => {
    const attacker = startCollector()
    const originUrl = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: `${attacker.url}/collect` },
        })
    )
    const http = new PlatformHttp(originUrl, AUTH_HEADERS)

    try {
      await http.request("/path")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError)
      expect(refine<PlatformError>(error).status).toBe(302)
    }
    for (const request of attacker.requests) {
      expect(request.headers["x-agent-accesskey"]).toBeUndefined()
      expect(request.headers["cookie"]).toBeUndefined()
    }
  })

  test("same-origin redirect is followed and carries the auth headers", async () => {
    const realRequests: SeenRequest[] = []
    const originUrl = startServer((request) => {
      const path = new URL(request.url).pathname
      if (path === "/path") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/real" },
        })
      }
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      realRequests.push({ url: request.url, headers })
      return Response.json({ ok: true })
    })
    const http = new PlatformHttp(originUrl, AUTH_HEADERS)

    const response = await http.request("/path")
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ ok: true })
    expect(realRequests).toHaveLength(1)
    expect(realRequests[0].headers["x-agent-accesskey"]).toBe("ak_secret")
    expect(realRequests[0].headers["cookie"]).toBe("session=cookie_secret")
  })
})
