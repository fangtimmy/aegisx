import { afterEach, describe, expect, test } from "bun:test"

import { PlatformError, PlatformHttp } from "../../src/platforms/core"
import { refine } from "../support"

/** Real-clock tests: the backoff ladder starts at 1s, so these pin both the
 * retry count and a lower bound on elapsed time (a stubbed clock would test
 * nothing about the waits). Budget: ~5s total. */

let servers: { stop(): void }[] = []

function startServer(handler: (request: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

afterEach(() => {
  for (const server of servers) server.stop()
  servers = []
})

/** Counter server: the first `failures` GETs answer `status`, then 200 JSON.
 * POSTs always answer `status` (they must never be replayed). */
function flakyServer(status: number, failures: number, retryAfter?: string) {
  let requests = 0
  const url = startServer(() => {
    requests += 1
    if (requests > failures) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })
    }
    const headers: Record<string, string> = { "content-type": "text/plain" }
    if (retryAfter !== undefined) headers["retry-after"] = retryAfter
    return new Response("slow down", { status, headers })
  })
  return { url, seen: () => requests }
}

describe("PlatformHttp transport retry", () => {
  test("retries a rate-limited GET until success", async () => {
    const { url, seen } = flakyServer(429, 1)
    const http = new PlatformHttp(url, {})
    const started = Date.now()
    const body = await http.json<{ ok: boolean }>("/x")
    expect(body.ok).toBe(true)
    expect(seen()).toBe(2)
    // One backoff wait: 1s base + jitter.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  test("exhausts bounded retries and rethrows the last status", async () => {
    const { url, seen } = flakyServer(503, 99)
    const http = new PlatformHttp(url, {})
    const error = await http.json("/x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformError)
    expect(refine<PlatformError>(error).status).toBe(503)
    expect(seen()).toBe(4) // initial + MAX_RETRIES
  }, 15_000)

  test("a numeric Retry-After steers the wait below the backoff ladder", async () => {
    const { url, seen } = flakyServer(429, 2, "1")
    const http = new PlatformHttp(url, {})
    const started = Date.now()
    await http.json("/x")
    expect(seen()).toBe(3)
    // Two waits of ~1s each; the 1s→2s backoff ladder would need ≥3s.
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(1800)
    expect(elapsed).toBeLessThan(2900)
  })

  test("never replays a POST", async () => {
    const { url, seen } = flakyServer(429, 99)
    const http = new PlatformHttp(url, {})
    const error = await http
      .request("/answer", { method: "POST", body: "{}" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformError)
    expect(refine<PlatformError>(error).status).toBe(429)
    expect(seen()).toBe(1)
  })

  test("does not retry a definitive status (404)", async () => {
    const { url, seen } = flakyServer(404, 99)
    const http = new PlatformHttp(url, {})
    await expect(http.json("/x")).rejects.toMatchObject({ status: 404 })
    expect(seen()).toBe(1)
  })
})
