import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Context, Hono } from "hono"

import { createDatabase } from "../../src/db"
import { agentAuth } from "../../src/infrastructure/agent-auth"

const echo = (c: Context) => c.json({ ok: true })

const tempDirs: string[] = []
const closeFns: Array<() => void> = []

afterEach(async () => {
  for (const close of closeFns.splice(0)) close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

/** Minimal app: the auth middleware plus echo routes mirroring the real
 * agent-addressable surface, so status codes reflect the verdict alone. */
function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-agent-auth-"))
  tempDirs.push(path)
  const { db, sqlite, releaseLock } = createDatabase(path)
  closeFns.push(() => {
    sqlite.close()
    releaseLock()
  })
  sqlite.run(
    `insert into events (id,name,created_at,updated_at,prompt_brief) values ('e1','E1','t','t',''),('e2','E2','t','t','')`
  )
  sqlite.run(
    `insert into challenges (id,event_id,name,description,category,points,created_at,updated_at) values ('c1','e1','C1','','web',100,'t','t'),('c2','e2','C2','','web',100,'t','t')`
  )
  const agent = (
    id: string,
    token: string,
    eventId: string,
    challengeId: string | null,
    role: "solver" | "orchestrator"
  ) =>
    sqlite.run(
      `insert into agents (id,token,event_id,challenge_id,role,model,system_prompt,tools,status,source,created_at,updated_at)
       values (?, ?, ?, ?, ?, 'm', 'p', '[]', 'running', 'manual', 't', 't')`,
      [id, token, eventId, challengeId, role]
    )
  agent("solver-e1", "SOLVER-1", "e1", "c1", "solver")
  agent("orch-e1", "ORCH-1", "e1", null, "orchestrator")
  agent("solver-e2", "SOLVER-2", "e2", "c2", "solver")
  agent("orch-e2", "ORCH-2", "e2", null, "orchestrator")

  const app = new Hono()
  app.use("*", agentAuth(db))
  app.get("/api/agents/:agentId", echo)
  app.delete("/api/agents/:agentId", echo)
  app.get("/api/agents/:agentId/messages", echo)
  app.get("/api/agents/:agentId/channels", echo)
  app.get("/api/events/:eventId", echo)
  app.get("/api/events/:eventId/fleet", echo)
  app.get("/api/events/:eventId/scheduler", echo)
  app.get("/api/events/:eventId/queue", echo)
  app.post("/api/events/:eventId/queue", echo)
  app.patch("/api/events/:eventId/queue/:itemId", echo)
  app.delete("/api/events/:eventId/queue/:itemId", echo)
  app.get("/api/challenges/:challengeId", echo)
  app.post("/api/challenges/:challengeId/agents", echo)
  return app
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` })

describe("agentAuth — agent API surface", () => {
  test("solver reads its own detail, messages, and channels", async () => {
    const app = createTestApp()
    for (const path of [
      "/api/agents/solver-e1",
      "/api/agents/solver-e1/messages",
      "/api/agents/solver-e1/channels",
    ]) {
      expect(
        (await app.request(path, { headers: authed("SOLVER-1") })).status
      ).toBe(200)
    }
  })

  test("solver is denied foreign agents and the events/challenges face", async () => {
    const app = createTestApp()
    for (const [method, path] of [
      ["GET", "/api/agents/solver-e2"],
      ["GET", "/api/agents/orch-e1"],
      ["DELETE", "/api/agents/solver-e1"],
      ["GET", "/api/events/e1"],
      ["GET", "/api/events/e1/queue"],
      ["GET", "/api/challenges/c1"],
      ["POST", "/api/challenges/c1/agents"],
    ] as const) {
      expect(
        (
          await app.request(path, {
            method,
            headers: authed("SOLVER-1"),
          })
        ).status
      ).toBe(403)
    }
  })

  test("scheduler reads and manages its own event", async () => {
    const app = createTestApp()
    for (const path of [
      "/api/events/e1",
      "/api/events/e1/fleet",
      "/api/events/e1/scheduler",
      "/api/events/e1/queue",
      "/api/agents/solver-e1",
      "/api/challenges/c1",
    ]) {
      expect(
        (await app.request(path, { headers: authed("ORCH-1") })).status
      ).toBe(200)
    }
    expect(
      (
        await app.request("/api/events/e1/queue", {
          method: "POST",
          headers: authed("ORCH-1"),
        })
      ).status
    ).toBe(200)
    expect(
      (
        await app.request("/api/events/e1/queue/q1", {
          method: "DELETE",
          headers: authed("ORCH-1"),
        })
      ).status
    ).toBe(200)
  })

  test("scheduler cannot PATCH a queue item (the SDK queue.edit gap)", async () => {
    const app = createTestApp()
    expect(
      (
        await app.request("/api/events/e1/queue/q1", {
          method: "PATCH",
          headers: authed("ORCH-1"),
        })
      ).status
    ).toBe(403)
  })

  test("scheduler is denied everything of another event", async () => {
    const app = createTestApp()
    for (const [method, path] of [
      ["GET", "/api/events/e2"],
      ["GET", "/api/events/e2/queue"],
      ["DELETE", "/api/events/e2/queue/q2"],
      ["GET", "/api/agents/solver-e2"],
      ["GET", "/api/challenges/c2"],
      ["POST", "/api/challenges/c2/agents"],
    ] as const) {
      expect(
        (
          await app.request(path, {
            method,
            headers: authed("ORCH-1"),
          })
        ).status
      ).toBe(403)
    }
  })

  test("an invalid token is 401, not a pass-through", async () => {
    const app = createTestApp()
    expect(
      (
        await app.request("/api/agents/solver-e1", {
          headers: authed("bogus"),
        })
      ).status
    ).toBe(401)
  })

  test("a tokenless request passes through as the user face", async () => {
    const app = createTestApp()
    expect((await app.request("/api/events/e1")).status).toBe(200)
  })
})
