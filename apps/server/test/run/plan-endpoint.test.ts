import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"

import { createApp } from "../../src/app"
import {
  agents as agentsTable,
  challenges as challengesTable,
  domainEvents,
  events as eventsTable,
} from "../../src/db/schema"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-plan-endpoint-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return instance
}

const now = () => new Date("2025-01-01T00:00:00Z").toISOString()

const token = () =>
  crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")

function seedPlanFixture(db: ReturnType<typeof createTestApp>["db"]) {
  const schedulerToken = token()
  const solverToken = token()
  db.insert(eventsTable)
    .values({
      id: "evt-1",
      name: "Plan Event",
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
  db.insert(challengesTable)
    .values({
      id: "ch-1",
      eventId: "evt-1",
      name: "Plan Challenge",
      description: "plan fixture",
      createdAt: now(),
      updatedAt: now(),
    })
    .run()
  for (const [id, authToken, challengeId, role] of [
    ["a-sched", schedulerToken, null, "orchestrator"],
    ["a-solver", solverToken, "ch-1", "solver"],
  ] as const) {
    db.insert(agentsTable)
      .values({
        id,
        token: authToken,
        eventId: "evt-1",
        challengeId,
        role,
        name: `agent-${id.slice(0, 8)}`,
        model: "aegisx-x/y:off",
        systemPrompt: "sys",
        tools: "[]",
        status: "idle",
        source: "manual",
        timeoutMs: 3_600_000,
        createdAt: now(),
        startedAt: now(),
        updatedAt: now(),
      })
      .run()
  }
  return { schedulerToken, solverToken }
}

function post(
  app: ReturnType<typeof createTestApp>["app"],
  path: string,
  body: unknown,
  bearer?: string
) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("POST /api/events/:eventId/plan", () => {
  test("scheduler submits a plan: 200 with per-ref results + queueAfter", async () => {
    const instance = createTestApp()
    const { schedulerToken } = seedPlanFixture(instance.db)
    const response = await post(
      instance.app,
      "/api/events/evt-1/plan",
      {
        rationale: "deliberate pass",
        actions: [{ ref: "n1", kind: "noOp", reason: "nothing to do" }],
      },
      schedulerToken
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.results[0]).toMatchObject({ ref: "n1", kind: "noOp", ok: true })
    expect(body.queueAfter).toEqual([])
    expect(body.deferred).toEqual([])
    // The proposal + its result are on the decision log.
    const proposed = instance.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.eventId, "evt-1"),
          eq(domainEvents.type, "plan.proposed")
        )
      )
      .all()
    expect(proposed).toHaveLength(1)
    expect(proposed[0].actorId).toBe("a-sched")
    expect(
      instance.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.eventId, "evt-1"),
            eq(domainEvents.type, "plan.result")
          )
        )
        .all()
    ).toHaveLength(1)
  })

  test("solver is forbidden (scheduler-only surface)", async () => {
    const instance = createTestApp()
    const { solverToken } = seedPlanFixture(instance.db)
    const response = await post(
      instance.app,
      "/api/events/evt-1/plan",
      {
        rationale: "r",
        actions: [{ ref: "n1", kind: "noOp", reason: "x" }],
      },
      solverToken
    )
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe("forbidden")
  })

  test("per-ref validation failures are 200 plan outcomes; malformed schema is 400", async () => {
    const instance = createTestApp()
    const { schedulerToken } = seedPlanFixture(instance.db)
    const rejected = await post(
      instance.app,
      "/api/events/evt-1/plan",
      {
        rationale: "r",
        actions: [{ ref: "e1", kind: "enqueue", challengeId: "ch-nope" }],
      },
      schedulerToken
    )
    expect(rejected.status).toBe(200)
    const rejectedBody = await rejected.json()
    expect(rejectedBody.results[0]).toMatchObject({
      ref: "e1",
      ok: false,
      code: "unknown_challenge",
    })

    const malformed = await post(
      instance.app,
      "/api/events/evt-1/plan",
      { rationale: "r", actions: [{ kind: "bogus" }] },
      schedulerToken
    )
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error.code).toBe("invalid_request")

    const noRationale = await post(
      instance.app,
      "/api/events/evt-1/plan",
      { actions: [{ ref: "n1", kind: "noOp", reason: "x" }] },
      schedulerToken
    )
    expect(noRationale.status).toBe(400)
  })

  test("a foreign event is denied at the verdict (403, no existence leak)", async () => {
    const instance = createTestApp()
    const { schedulerToken } = seedPlanFixture(instance.db)
    const response = await post(
      instance.app,
      "/api/events/evt-nope/plan",
      { rationale: "r", actions: [{ ref: "n1", kind: "noOp", reason: "x" }] },
      schedulerToken
    )
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("forbidden")
  })
})
