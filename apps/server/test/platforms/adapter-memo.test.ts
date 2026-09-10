import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { challengeRemote, eventPlatforms } from "../../src/db/schema"
import type { ConfigStore } from "../../src/infrastructure/config-store"
import { createStorage } from "../../src/infrastructure/storage"
import { createPlatformService } from "../../src/platforms/service"
import {
  flatSettings,
  now,
  seedChallenge,
  seedEvent,
  setupDb,
} from "../helpers"
import { refine } from "../support"

const BASE_URL = "https://tsec.example"
const SOURCE_KEY = JSON.stringify(["tsecbench", BASE_URL, "task"])

const item = {
  unique_code: "a-17",
  description: "Break the service.",
  difficulty: "hard",
  level: 3,
  total_score: 300,
  flag_count: 1,
  correct_flag_count: 0,
  is_completed: false,
  // "stopped": detach's assertNoActiveTargets must see an inactive target.
  container_status: "stopped",
  container_addr: [],
}

/** Fetch stub serving the list fixture; records every list GET and the
 * credential header each request carried (instance identity via behavior). */
function stubFetch() {
  const original = globalThis.fetch
  const tokens: (string | undefined)[] = []
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
    if ((init?.method ?? "GET") === "GET" && url.includes("/challenges")) {
      tokens.push(
        new Headers(init?.headers).get("BENCHMARK_TOKEN") ?? undefined
      )
      return new Response(JSON.stringify([item]), {
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response("no stub", { status: 404 })
  }
  globalThis.fetch = refine<typeof fetch>(stub)
  return {
    listCalls: () => tokens.length,
    tokens: () => tokens,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

describe("platform adapter memoization", () => {
  test("reads reuse one adapter per event; rebinding rebuilds it", async () => {
    const { db, dir, close } = setupDb()
    const stub = stubFetch()
    try {
      seedEvent(db)
      seedChallenge(db, { id: "ch-1" })
      db.insert(eventPlatforms)
        .values({
          eventId: "evt-1",
          type: "tsecbench",
          baseUrl: BASE_URL,
          credential: "token-1",
          remoteEventId: "task",
          sourceKey: SOURCE_KEY,
          createdAt: now(),
          updatedAt: now(),
        })
        .run()
      db.insert(challengeRemote)
        .values({
          challengeId: "ch-1",
          eventId: "evt-1",
          sourceKey: SOURCE_KEY,
          remoteId: "a-17",
          available: true,
          targetSupported: true,
          syncedAt: now(),
        })
        .run()
      const service = createPlatformService(
        db,
        createStorage(dir),
        () => 1024 * 1024,
        refine<ConfigStore>({
          getProviders: () => [],
          getSettings: flatSettings,
        })
      )

      // Two target reads share one adapter instance and its short-lived list
      // cache: a single upstream fetch instead of one per SDK get_target.
      await service.targetAction("ch-1", "get")
      await service.targetAction("ch-1", "get")
      expect(stub.listCalls()).toBe(1)
      expect(stub.tokens()).toEqual(["token-1"])

      // Rebinding (detach + bind) replaces the binding row, so the memo must
      // be dropped: the next read builds a fresh adapter with the new
      // credential and fetches the list again.
      await service.detach("evt-1")
      await service.bind("evt-1", {
        type: "tsecbench",
        baseUrl: BASE_URL,
        credential: "token-2",
        remoteEventId: "task",
      })
      db.update(challengeRemote)
        .set({ available: true })
        .where(eq(challengeRemote.challengeId, "ch-1"))
        .run()
      await service.targetAction("ch-1", "get")
      // 1 cached read + 1 bind listEvents validation + 1 post-rebind read.
      expect(stub.listCalls()).toBe(3)
      expect(stub.tokens().at(-1)).toBe("token-2")
    } finally {
      stub.restore()
      close()
    }
  })
})
