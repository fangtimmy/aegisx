import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { createApp } from "../src/app"
import {
  agents,
  challengeFlags,
  challengeRemote,
  challenges,
} from "../src/db/schema"
import { responseJson } from "../src/lib/guards"
import { seedAgent, seedChallenge, seedEvent } from "./helpers"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-maintenance-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance
}

const now = () => new Date().toISOString()

function seedSolvedChallenge(
  db: ReturnType<typeof createTestApp>["db"],
  id = "ch-1"
) {
  seedChallenge(db, { id, manualSolveState: "solved", solvedAt: now() })
  db.insert(challengeFlags)
    .values({
      id: `flag-${id}`,
      challengeId: id,
      flag: "flag{test}",
      status: "accepted",
      source: "manual",
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
  db.insert(challengeRemote)
    .values({
      challengeId: id,
      eventId: "evt-1",
      sourceKey: "source",
      remoteId: `r-${id}`,
      available: true,
      solved: true,
      targetSupported: false,
      targetIgnored: false,
      targetCount: 0,
      targetInfo: "[]",
      syncedAt: now(),
    })
    .run()
}

describe("event maintenance routes", () => {
  test("challenge flag reset drops flags and re-derives to unsolved", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    seedSolvedChallenge(instance.db)
    const response = await instance.app.request("/api/challenges/ch-1/flags", {
      method: "DELETE",
    })
    expect(response.status).toBe(204)
    const challenge = instance.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, "ch-1"))
      .get()
    expect(challenge?.manualSolveState).toBe("unsolved")
    expect(challenge?.solvedAt).toBeNull()
    expect(
      instance.db
        .select()
        .from(challengeFlags)
        .where(eq(challengeFlags.challengeId, "ch-1"))
        .all()
    ).toHaveLength(0)
    expect(
      instance.db
        .select({ solved: challengeRemote.solved })
        .from(challengeRemote)
        .get()?.solved
    ).toBe(false)
  })

  test("event flag reset reports the challenge count", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    seedSolvedChallenge(instance.db, "ch-1")
    seedSolvedChallenge(instance.db, "ch-2")
    const response = await instance.app.request("/api/events/evt-1/flags", {
      method: "DELETE",
    })
    expect(response.status).toBe(200)
    const body = await responseJson<{ reset: number }>(response)
    expect(body.reset).toBe(2)
    const solved = instance.db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.manualSolveState, "solved"))
      .all()
    expect(solved).toHaveLength(0)
  })

  test("maintenance routes refuse while the event has live agents", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    seedChallenge(instance.db)
    seedAgent(instance.db, { id: "agent-live", status: "running" })
    for (const path of [
      "/api/events/evt-1/channels",
      "/api/events/evt-1/flags",
      "/api/challenges/ch-1/channels",
      "/api/challenges/ch-1/flags",
    ]) {
      const response = await instance.app.request(path, { method: "DELETE" })
      expect(response.status).toBe(409)
      const body = await responseJson<{ error: { code: string } }>(response)
      expect(body.error.code).toBe("active_agent")
    }
  })

  test("channel purge clears the team channel of one challenge only", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    seedChallenge(instance.db, { id: "ch-1" })
    seedChallenge(instance.db, { id: "ch-2" })
    for (const challengeId of ["ch-1", "ch-2"]) {
      const form = new FormData()
      form.set("text", `note for ${challengeId}`)
      const posted = await instance.app.request(
        `/api/channels/team:${challengeId}/messages`,
        { method: "POST", body: form }
      )
      expect(posted.status).toBe(201)
    }
    const purged = await instance.app.request("/api/challenges/ch-1/channels", {
      method: "DELETE",
    })
    expect(purged.status).toBe(204)
    const remaining = await instance.app.request(
      "/api/channels/team:ch-2/messages"
    )
    expect(remaining.status).toBe(200)
    const body = await responseJson<{ items: unknown[] }>(remaining)
    expect(body.items).toHaveLength(1)
  })

  test("event halt and resume orchestrate cleanly on a quiet event", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    const halted = await instance.app.request("/api/events/evt-1/halt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(halted.status).toBe(200)
    expect(await halted.json()).toEqual({
      closed: 0,
      targetsStopped: 0,
      targetFailures: 0,
    })
    // The halt froze the queue: the queue view reports paused…
    const queue = await instance.app.request("/api/events/evt-1/queue")
    expect((await responseJson<{ state: string }>(queue)).state).toBe("paused")
    // …and the scheduler pause flag is set (fleet config).
    const fleet = await instance.app.request("/api/events/evt-1/fleet")
    expect(
      (await responseJson<{ config: { paused: boolean } }>(fleet)).config.paused
    ).toBe(true)

    const resumed = await instance.app.request("/api/events/evt-1/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toEqual({ state: "running" })
    const queueAfter = await instance.app.request("/api/events/evt-1/queue")
    expect((await responseJson<{ state: string }>(queueAfter)).state).toBe(
      "running"
    )
  })

  test("halt on an unknown event 404s", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    const response = await instance.app.request("/api/events/nope/halt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(404)
  })

  test("agents/close closes live solvers only and reports the count", async () => {
    const instance = createTestApp()
    seedEvent(instance.db)
    seedChallenge(instance.db)
    seedAgent(instance.db, { id: "agent-live", status: "running" })
    seedAgent(instance.db, {
      id: "agent-done",
      status: "completed",
    })
    seedAgent(instance.db, {
      id: "agent-orch",
      role: "orchestrator",
      challengeId: null,
      status: "idle",
    })
    const response = await instance.app.request(
      "/api/events/evt-1/agents/close",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ closed: 1 })
    const rows = instance.db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .all()
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.id === "agent-live")?.status).toBe("aborted")
    expect(rows.find((row) => row.id === "agent-orch")?.status).toBe("idle")
  })
})
