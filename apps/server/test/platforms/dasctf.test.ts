import { describe, expect, test } from "bun:test"

import { DasCtfAdapter } from "../../src/platforms/adapters/dasctf"
import type { PlatformConfig } from "../../src/platforms/core"
import { PlatformError } from "../../src/platforms/core"
import { refine } from "../support"

const config: PlatformConfig = {
  type: "dasctf",
  baseUrl: "https://pro.dasctf.com",
  credential: "ak_test",
  remoteEventId: "match",
}

type Route = {
  match: string | RegExp
  body?: unknown
  status?: number
}

/** URL string of a fetch input (URL / string / Request). */
function requestUrlOf(input: URL | RequestInfo): string {
  if (input instanceof URL) return input.href
  return typeof input === "string" ? input : input.url
}

/** Stub globalThis.fetch with URL-matched JSON routes; record every call.
 * Routes are consumed in order: each request removes the first matching
 * route, so sequential calls to the same URL get distinct responses. */
function stubFetch(routes: Route[]) {
  const original = globalThis.fetch
  const queue = [...routes]
  const calls: { url: string; init: RequestInit | undefined }[] = []
  globalThis.fetch = refine<typeof fetch>(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = requestUrlOf(input)
      calls.push({ url, init })
      const index = queue.findIndex((r) =>
        typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)
      )
      const route = index >= 0 ? queue.splice(index, 1)[0] : undefined
      if (!route) {
        return new Response("no stub route", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        })
      }
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      })
    }
  )
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const envelope = (data: unknown) => ({ code: "00000", message: "", data })

const detailRoute = (detail: unknown) => ({
  match: "/ctf/exercise?",
  body: envelope(detail),
})

const sampleDetail = {
  id: 1001,
  name: "easy-web",
  description: "题目描述",
  hasSolved: false,
  score: "100",
  difficulty: "EASY",
  // Live payloads send an empty array when the challenge has no attachment.
  attachment: [],
  endpoints: [],
  isNeedInit: false,
  isNeedCheck: false,
}

function headersOf(calls: { init: RequestInit | undefined }[], index = 0) {
  return refine<Record<string, string>>(calls[index].init?.headers)
}

describe("dasctf adapter", () => {
  test("authenticates with X-Agent-AccessKey and unwraps the envelope", async () => {
    const fetch = stubFetch([
      { match: "match-info", body: envelope({ note: "n", rule: "r" }) },
    ])
    try {
      await new DasCtfAdapter(config).testConnection()
      expect(fetch.calls[0].url).toBe(
        "https://pro.dasctf.com/slab-match/api/v1/agent/match/notice/match-info"
      )
      expect(headersOf(fetch.calls)["X-Agent-AccessKey"]).toBe("ak_test")
    } finally {
      fetch.restore()
    }
  })

  test("throws on a non-success envelope code", async () => {
    const fetch = stubFetch([
      { match: "match-info", body: { code: "A0001", message: "invalid key" } },
    ])
    try {
      await expect(new DasCtfAdapter(config).testConnection()).rejects.toThrow(
        "invalid key"
      )
    } finally {
      fetch.restore()
    }
  })

  test("listEvents returns a single synthetic match event", async () => {
    const fetch = stubFetch([
      { match: "match-info", body: envelope({ note: "n", rule: "r" }) },
    ])
    try {
      const events = await new DasCtfAdapter(config).listEvents()
      expect(events).toEqual([{ id: "match", name: "DASCTF Match" }])
    } finally {
      fetch.restore()
    }
  })

  test("listChallenges flattens categories and skips closed exercises", async () => {
    const fetch = stubFetch([
      {
        match: "exercise-list",
        body: envelope([
          {
            id: 10,
            name: "Web",
            corpus: [
              { id: 1001, name: "easy-web", isOpen: true, hasSolved: false },
              { id: 1002, name: "hidden", isOpen: false, hasSolved: false },
            ],
          },
          {
            id: 20,
            name: "Pwn",
            corpus: [{ id: 2001, name: "easy-pwn", hasSolved: true }],
          },
        ]),
      },
    ])
    try {
      const items = await new DasCtfAdapter(config).listChallenges()
      expect(items).toEqual([
        {
          id: "1001",
          name: "easy-web",
          category: "Web",
          points: null,
          solved: false,
        },
        {
          id: "2001",
          name: "easy-pwn",
          category: "Pwn",
          points: null,
          solved: true,
        },
      ])
    } finally {
      fetch.restore()
    }
  })

  test("getChallenge maps single-object attachments and placeholder targets", async () => {
    // Live shape (observed on pro.dasctf.com): attachment is a single
    // cross-origin file object keyed by `extension`, and the challenge needs
    // its environment initialized before endpoints exist.
    const fetch = stubFetch([
      detailRoute({
        ...sampleDetail,
        isNeedInit: true,
        attachment: {
          key: "5747726b67cd4fb3a8389dba4e73b2e1",
          signature: "0505d1b5450e260dd321f74e949643b4",
          url: "https://pro-resource.dasctf.com/resource/oss/05102743e9d552980a3b247a070f451b.zip",
          name: "shopping的附件.zip",
          extension: "zip",
        },
      }),
    ])
    try {
      const challenge = await new DasCtfAdapter(config).getChallenge("1001")
      expect(challenge.description).toBe("题目描述")
      expect(challenge.points).toBe(100)
      // The detail payload has no category; the sync layer backfills it.
      expect(challenge.category).toBeNull()
      expect(challenge.attachments).toEqual([
        {
          id: "https://pro-resource.dasctf.com/resource/oss/05102743e9d552980a3b247a070f451b.zip",
          filename: "shopping的附件.zip",
          url: "https://pro-resource.dasctf.com/resource/oss/05102743e9d552980a3b247a070f451b.zip",
          authenticated: false,
        },
      ])
      expect(challenge.targetSupported).toBe(true)
      expect(challenge.targetCount).toBe(1)
      expect(challenge.targets).toEqual([{ name: "easy-web", services: [] }])
    } finally {
      fetch.restore()
    }
  })

  test("getChallenge accepts the documented {files} shape and maps endpoint targets", async () => {
    const fetch = stubFetch([
      detailRoute({
        ...sampleDetail,
        attachment: {
          files: [
            {
              name: "attachment.zip",
              url: "https://pro.dasctf.com/file/1",
              ext: "zip",
            },
          ],
        },
        endpoints: [
          { exposeIps: ["192.168.0.24"], ports: ["http/80", "tcp/22"] },
        ],
      }),
    ])
    try {
      const challenge = await new DasCtfAdapter(config).getChallenge("1001")
      expect(challenge.attachments).toEqual([
        {
          id: "https://pro.dasctf.com/file/1",
          filename: "attachment.zip",
          url: "https://pro.dasctf.com/file/1",
          authenticated: true,
        },
      ])
      expect(challenge.targetCount).toBe(1)
      expect(challenge.targets).toEqual([
        { name: "endpoint 1", services: ["80", "22"] },
      ])
    } finally {
      fetch.restore()
    }
  })

  test("getChallenge treats numeric port entries as bare ports", async () => {
    // The platform sends numbers despite the documented string[] type.
    const fetch = stubFetch([
      detailRoute({
        ...sampleDetail,
        endpoints: [{ exposeIps: ["10.0.0.10"], ports: [80, "http/443"] }],
      }),
    ])
    try {
      const challenge = await new DasCtfAdapter(config).getChallenge("1001")
      expect(challenge.targets).toEqual([
        { name: "endpoint 1", services: ["80", "443"] },
      ])
    } finally {
      fetch.restore()
    }
  })

  test("getSolveState reads hasSolved; missing exercise is a 404", async () => {
    const fetch = stubFetch([
      detailRoute({ ...sampleDetail, hasSolved: true }),
      detailRoute({}),
    ])
    try {
      const adapter = new DasCtfAdapter(config)
      expect(await adapter.getSolveState("1001")).toBe(true)
      try {
        await adapter.getSolveState("1001")
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(PlatformError)
        expect(refine<PlatformError>(error).status).toBe(404)
      }
    } finally {
      fetch.restore()
    }
  })

  test("submitFlag maps verdicts and envelope errors, but propagates HTTP failures", async () => {
    const fetch = stubFetch([
      { match: "answer-panel/answer", body: envelope({ isCorrect: true }) },
      {
        match: "answer-panel/answer",
        body: { code: "B1001", message: "flag 错误" },
      },
      { match: "answer-panel/answer", status: 502, body: "bad gateway" },
    ])
    try {
      const adapter = new DasCtfAdapter(config)
      expect(await adapter.submitFlag("1001", "flag{ok}")).toEqual({
        status: "accepted",
      })
      expect(await adapter.submitFlag("1001", "flag{bad}")).toEqual({
        status: "rejected",
        message: "flag 错误",
      })
      // POST body carries the numeric exerciseId.
      expect(fetch.calls[1]?.init?.body).toBe(
        JSON.stringify({ exerciseId: 1001, flag: "flag{bad}" })
      )
      try {
        await adapter.submitFlag("1001", "flag{x}")
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(PlatformError)
        expect(refine<PlatformError>(error).status).toBe(502)
      }
    } finally {
      fetch.restore()
    }
  })

  test("getTarget maps lifecycle flags, prefixed ports and port-embedded hosts", async () => {
    const fetch = stubFetch([
      detailRoute({ ...sampleDetail, isNeedInit: true }),
      detailRoute({ ...sampleDetail, isNeedCheck: true }),
      // Live running shape: proxy endpoint, mapping type http.
      detailRoute({
        ...sampleDetail,
        endpoints: [
          {
            objectId: "endpoint_07ddbccc72e04b3e985e8e3f92cdbdf2",
            exposeIps: ["192.168.0.24"],
            serviceStatus: "UP",
            status: "running",
            ports: ["http/80"],
            users: [],
            portMappings: [{ type: "http", port: "80", proxy: "25457" }],
            proxyIps: ["1.14.76.59"],
            isProxy: true,
            expireTime: 1_780_000_000_000,
          },
        ],
      }),
      // Direct endpoint whose host already embeds the mapped port.
      detailRoute({
        ...sampleDetail,
        endpoints: [
          {
            exposeIps: ["1.14.76.59:25457"],
            ports: ["http/80"],
            portMappings: [{ type: "http", port: "80", proxy: "25457" }],
            isProxy: false,
          },
        ],
      }),
      // Documented direct shape: bare hosts × bare ports + credentials.
      detailRoute({
        ...sampleDetail,
        endpoints: [
          {
            exposeIps: ["10.0.0.10"],
            ports: ["80", "22"],
            users: [{ username: "root", password: "pw" }],
            isProxy: false,
          },
        ],
      }),
    ])
    try {
      const adapter = new DasCtfAdapter(config)
      expect(await adapter.getTarget("1001")).toEqual({
        status: "absent",
        endpoints: [],
        expiresAt: null,
      })
      expect(await adapter.getTarget("1001")).toEqual({
        status: "starting",
        endpoints: [],
        expiresAt: null,
      })
      // Proxy route: proxyIp × mapped proxy port, protocol from mapping type.
      expect(await adapter.getTarget("1001")).toEqual({
        status: "running",
        endpoints: [
          {
            name: "endpoint 1:25457",
            address: "http://1.14.76.59:25457",
            protocol: "http",
          },
        ],
        expiresAt: new Date(1_780_000_000_000).toISOString(),
      })
      // Host with embedded port: used as-is, protocol from the port entry.
      expect((await adapter.getTarget("1001")).endpoints).toEqual([
        {
          name: "endpoint 1:25457",
          address: "http://1.14.76.59:25457",
          protocol: "http",
        },
      ])
      // Bare hosts × bare ports expand directly.
      expect((await adapter.getTarget("1001")).endpoints).toEqual([
        {
          name: "endpoint 1:80",
          address: "10.0.0.10:80",
          protocol: "tcp",
          guidance: ["credentials: root / pw"],
        },
        {
          name: "endpoint 1:22",
          address: "10.0.0.10:22",
          protocol: "tcp",
          guidance: ["credentials: root / pw"],
        },
      ])
    } finally {
      fetch.restore()
    }
  })

  test("startTarget builds the environment; stopTarget recovers it", async () => {
    const fetch = stubFetch([
      { match: "build-exercise-env", body: envelope({}) },
      detailRoute({ ...sampleDetail, isNeedCheck: true }),
      { match: "recover-exercise-env", body: envelope({}) },
      detailRoute({ ...sampleDetail, isNeedInit: true }),
    ])
    try {
      const adapter = new DasCtfAdapter(config)
      expect((await adapter.startTarget("1001")).status).toBe("starting")
      expect(fetch.calls[0].init?.method).toBe("POST")
      expect(fetch.calls[0].init?.body).toBe(
        JSON.stringify({ exerciseId: 1001 })
      )
      expect((await adapter.stopTarget("1001")).status).toBe("absent")
    } finally {
      fetch.restore()
    }
  })
})
