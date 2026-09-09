import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { platformRequestLog } from "../../src/db/schema"
import type { ConfigStore } from "../../src/infrastructure/config-store"
import { createStorage } from "../../src/infrastructure/storage"
import {
  clipBody,
  createPlatformService,
  redactHeaders,
} from "../../src/platforms/service"
import { flatSettings, setupDb } from "../helpers"
import { refine } from "../support"

function logRow(id: string, createdAt: string) {
  return {
    id,
    createdAt,
    method: "GET",
    url: "https://old.example/api",
    requestHeaders: "{}",
    requestBody: null,
    status: null,
    responseHeaders: null,
    responseBody: null,
    error: "stale",
  }
}

function makeService(db: ReturnType<typeof setupDb>["db"], dir: string) {
  return createPlatformService(
    db,
    createStorage(dir),
    () => 1024 * 1024,
    refine<ConfigStore>({
      getProviders: () => [],
      getLegacyPromptTemplates: () => undefined,
      getSettings: flatSettings,
    })
  )
}

/** fetch stub: a 500 carrying an oversized body — drives the HTTP-error log
 * path (redacted request headers + capped response body) with no network. */
const failingFetch: typeof fetch = Object.assign(
  async () => new Response("y".repeat(10_000), { status: 500 }),
  { preconnect: () => {} }
)

describe("platform_request_log hygiene", () => {
  test("redactHeaders blanks credential headers case-insensitively, keeps the rest", () => {
    const redacted = redactHeaders({
      Authorization: "Bearer sekret",
      cookie: "session=xyz",
      "X-Agent-AccessKey": "key-123",
      "Benchmark-Token": "tok-456",
      Accept: "application/json",
    })
    expect(redacted).toEqual({
      Authorization: "[redacted]",
      cookie: "[redacted]",
      "X-Agent-AccessKey": "[redacted]",
      "Benchmark-Token": "[redacted]",
      Accept: "application/json",
    })
  })

  test("clipBody caps stored bodies at 8000 chars and passes null through", () => {
    expect(clipBody(null)).toBeNull()
    expect(clipBody("x".repeat(8001))?.length).toBe(8000)
    expect(clipBody("short")).toBe("short")
  })

  test("a failed request logs redacted headers and a truncated response body", async () => {
    const { db, dir, close } = setupDb()
    try {
      const platform = makeService(db, dir)
      const realFetch = globalThis.fetch
      globalThis.fetch = failingFetch
      try {
        await expect(
          platform.testConnection({
            type: "ctfd",
            baseUrl: "https://ctf.example",
            credential: "sekret",
          })
        ).rejects.toThrow()
      } finally {
        globalThis.fetch = realFetch
      }
      const row = db.select().from(platformRequestLog).get()
      expect(row).not.toBeNull()
      const headers = JSON.parse(row!.requestHeaders)
      expect(headers.Authorization).toBe("[redacted]")
      expect(headers["Content-Type"]).toBe("application/json")
      expect(row!.status).toBe(500)
      expect(row!.responseBody!.length).toBe(8000)
    } finally {
      close()
    }
  })

  test("service creation prunes log rows older than 7 days", () => {
    const { db, dir, close } = setupDb()
    try {
      const stamp = Date.now()
      const stale = new Date(stamp - 8 * 24 * 60 * 60 * 1000).toISOString()
      const fresh = new Date(stamp - 1000).toISOString()
      db.insert(platformRequestLog).values(logRow("old-1", stale)).run()
      db.insert(platformRequestLog).values(logRow("new-1", fresh)).run()

      makeService(db, dir)

      expect(
        db
          .select()
          .from(platformRequestLog)
          .where(eq(platformRequestLog.id, "old-1"))
          .get()
      ).toBeUndefined()
      expect(
        db
          .select()
          .from(platformRequestLog)
          .where(eq(platformRequestLog.id, "new-1"))
          .get()
      ).toBeDefined()
    } finally {
      close()
    }
  })
})
