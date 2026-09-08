import { afterEach, describe, expect, test } from "bun:test"

import { TsecBenchAdapter } from "../../src/platforms/adapters/tsecbench"
import type { PlatformConfig } from "../../src/platforms/core"
import { refine } from "../support"

const config: PlatformConfig = {
  type: "tsecbench",
  baseUrl: "https://tsec.example",
  credential: "bench-token",
  remoteEventId: "task",
}

const item = {
  unique_code: "a-17",
  description: "Break the service.",
  difficulty: "hard",
  level: 3,
  total_score: 300,
  flag_count: 2,
  correct_flag_count: 1,
  is_completed: false,
  container_status: "available",
  container_addr: ["10.0.0.1:8080"],
}

/** Persistent fetch stub: GET list serves the fixture; POST actions succeed.
 * Routes are NOT consumed — every call is served, and all calls recorded. */
function stubFetch() {
  const original = globalThis.fetch
  const calls: { url: string; method: string }[] = []
  const stub = async (
    input: URL | RequestInfo,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    if (url.includes("/openapi/v1/challenges/submit")) {
      return new Response("no stub", { status: 404 })
    }
    if (method !== "GET") return new Response(null, { status: 200 })
    if (url.includes("/openapi/v1/challenges")) {
      return new Response(JSON.stringify([item]), {
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response("no stub", { status: 404 })
  }
  globalThis.fetch = refine<typeof fetch>(stub)
  return {
    calls,
    listCalls: () => calls.filter((c) => c.method === "GET").length,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const stubs: Array<{ restore: () => void }> = []
afterEach(() => {
  for (const stub of stubs.splice(0)) stub.restore()
})

describe("TsecBench adapter: target-list caching", () => {
  test("back-to-back getTarget calls share one list fetch; start/stop invalidate", async () => {
    const stub = stubFetch()
    stubs.push(stub)
    const adapter = new TsecBenchAdapter(config)

    const first = await adapter.getTarget("a-17")
    expect(first.status).toBe("running")
    await adapter.getTarget("a-17")
    expect(stub.listCalls()).toBe(1)

    // A lifecycle action must observe its own effect, not a cached list.
    await adapter.startTarget("a-17")
    expect(stub.listCalls()).toBeGreaterThanOrEqual(2)
  })

  test("stored description carries the multi-flag note; detail reads share the list cache", async () => {
    const stub = stubFetch()
    stubs.push(stub)
    const adapter = new TsecBenchAdapter(config)

    const detail = await adapter.getChallenge("a-17")
    expect(detail.description).toContain("2 个 flag")
    expect(detail.description).not.toContain("flag format")
    // Synced descriptions stay cheap: two detail fetches still hit one list.
    await adapter.getChallenge("a-17")
    expect(stub.listCalls()).toBe(1)
  })
})
