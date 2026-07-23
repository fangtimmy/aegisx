import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import type { FrozenPromptConfig, ModelConfig } from "../../../shared"
import { createDatabase } from "../db"
import { challenges, events, runs } from "../db/schema"
import { createFakeRuntime } from "./runtime-port"
import { createRunService } from "./service"

const model: ModelConfig = {
  provider: "test",
  modelId: "m1",
  modelLabel: "Model One",
  thinkingLevel: "off",
}

const prompt: FrozenPromptConfig = {
  mainSystemPromptTemplate: "main",
  childSystemPromptTemplate: "child",
  initialPromptTemplate: "init",
}

const dirs: string[] = []

function setup(maxConcurrency = 4) {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-svc-"))
  dirs.push(dir)
  const { db, sqlite, releaseLock } = createDatabase(dir)
  const now = new Date().toISOString()
  db.insert(events)
    .values({
      id: "ev-1",
      name: "CTF",
      promptHint: "",
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(challenges)
    .values({
      id: "ch-1",
      eventId: "ev-1",
      name: "Web 1",
      description: "desc",
      category: "web",
      points: 100,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const runtime = createFakeRuntime()
  const eventsLog: Array<{ runId: string; type: string }> = []
  const service = createRunService({
    db,
    maxConcurrency,
    runtime,
    resolveChallenge: () => ({
      name: "Web 1",
      eventId: "ev-1",
      targetSupported: false,
    }),
    onLiveEvent: (runId, event) => {
      eventsLog.push({ runId, type: event.type })
    },
  })

  return {
    service,
    runtime,
    eventsLog,
    db,
    cleanup: () => {
      void service.close()
      sqlite.close()
      releaseLock()
    },
  }
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("run service L2", () => {
  test("create persists run and dispatches bootstrap", async () => {
    const { service, runtime, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "workspaces/r1",
        bootstrapText: "Solve Web 1",
      })
      expect(run.status).toBe("running")
      expect(run.mainAgentId).toBeTruthy()
      expect(run.mainAgentId).not.toBe(run.id)
      expect(run.challengeName).toBe("Web 1")
      expect(runtime.attached.has(run.mainAgentId)).toBe(true)
      expect(runtime.dispatches[0]?.text).toBe("Solve Web 1")
      expect(runtime.dispatches[0]?.kind).toBe("bootstrap")

      const agg = service.getAggregate(run.id)
      expect(agg?.agents).toHaveLength(1)
      const messages = service.store.listMessages(run.mainAgentId)
      expect(messages).toHaveLength(1)
      expect(messages[0]?.role).toBe("user")
    } finally {
      cleanup()
    }
  })

  test("pause and resume", async () => {
    const { service, runtime, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      const paused = await service.pause(run.id)
      expect(paused.status).toBe("paused")
      expect(runtime.aborted).toContain(run.id)

      const resumed = await service.resume(run.id, "keep going")
      expect(resumed.status).toBe("running")
      const resumeDispatch = runtime.dispatches.find(
        (d) => d.kind === "resume" && d.text === "keep going"
      )
      expect(resumeDispatch).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test("finish path: requestFinish + main settled success", async () => {
    const { service, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      await service.requestFinish(run.id, "flag{ok}")
      await service.onSettled(run.id, run.mainAgentId, {
        status: "success",
        summary: null,
        error: null,
      })
      const done = service.get(run.id)
      expect(done?.status).toBe("completed")
      expect(done?.summary).toBe("flag{ok}")
    } finally {
      cleanup()
    }
  })

  test("main settled success without finish → idle then user message", async () => {
    const { service, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      await service.onSettled(run.id, run.mainAgentId, {
        status: "success",
        summary: "thinking",
        error: null,
      })
      let agg = service.getAggregate(run.id)
      expect(agg?.agents[0]?.status).toBe("idle")
      expect(agg?.status).toBe("running")

      await service.postMessage(run.id, "try another approach")
      agg = service.getAggregate(run.id)
      expect(agg?.agents[0]?.status).toBe("running")
    } finally {
      cleanup()
    }
  })

  test("spawn child and child failure does not fail run", async () => {
    const { service, runtime, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      await service.onSettled(run.id, run.mainAgentId, {
        status: "success",
        summary: null,
        error: null,
      })
      const child = await service.spawn(
        run.id,
        run.mainAgentId,
        "Reverser",
        "reverse the binary"
      )
      expect(child.status).toBe("running")
      expect(runtime.attached.has(child.id)).toBe(true)

      await service.onSettled(run.id, child.id, {
        status: "error",
        summary: null,
        error: "segfault",
      })
      const agg = service.getAggregate(run.id)
      expect(agg?.status).toBe("running")
      const childRow = agg?.agents.find((a) => a.id === child.id)
      expect(childRow?.status).toBe("failed")
      const main = agg?.agents.find((a) => a.id === run.mainAgentId)
      expect(main?.status).toBe("running")
      const notices = service.store
        .listMessages(run.mainAgentId)
        .filter((m) => m.role === "notice")
      expect(notices.length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanup()
    }
  })

  test("capacity enforced on create", async () => {
    const { service, cleanup } = setup(1)
    try {
      await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w1",
        bootstrapText: "a",
      })
      await expect(
        service.create({
          challengeId: "ch-1",
          model,
          prompt,
          workspacePath: "w2",
          bootstrapText: "b",
        })
      ).rejects.toMatchObject({ code: "capacity" })
    } finally {
      cleanup()
    }
  })

  test("clientMessageId is idempotent", async () => {
    const { service, runtime, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      await service.onSettled(run.id, run.mainAgentId, {
        status: "success",
        summary: null,
        error: null,
      })
      const before = runtime.dispatches.length
      await service.postMessage(run.id, "hello", "client-1")
      await service.postMessage(run.id, "hello", "client-1")
      const userMsgs = service.store
        .listMessages(run.mainAgentId)
        .filter((m) => m.role === "user" && m.source === "user")
      expect(userMsgs).toHaveLength(1)
      expect(runtime.dispatches.length).toBe(before + 1)
    } finally {
      cleanup()
    }
  })

  test("recoverOnBoot pauses interrupted runs", async () => {
    const { service, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      await service.recoverOnBoot()
      const got = service.get(run.id)
      expect(got?.status).toBe("paused")
    } finally {
      cleanup()
    }
  })

  test("recoverOnBoot completes pending finish", async () => {
    const { service, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      await service.requestFinish(run.id, "saved")
      await service.recoverOnBoot()
      const got = service.get(run.id)
      expect(got?.status).toBe("completed")
      expect(got?.summary).toBe("saved")
    } finally {
      cleanup()
    }
  })

  test("containerFailed pauses", async () => {
    const { service, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      const paused = await service.containerFailed(run.id, "container missing")
      expect(paused.status).toBe("paused")
      expect(paused.error).toBe("container missing")
    } finally {
      cleanup()
    }
  })

  test("stop is terminal", async () => {
    const { service, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      const stopped = await service.stop(run.id)
      expect(stopped.status).toBe("stopped")
      await expect(service.pause(run.id)).rejects.toMatchObject({
        code: "invalid_state",
      })
    } finally {
      cleanup()
    }
  })

  test("refresh after flag write broadcasts run.updated with hasFlag", async () => {
    const { service, eventsLog, db, cleanup } = setup()
    try {
      const run = await service.create({
        challengeId: "ch-1",
        model,
        prompt,
        workspacePath: "w",
        bootstrapText: "go",
      })
      expect(service.get(run.id)?.hasFlag).toBe(false)
      // side-path write (platform submit), then refresh
      db.update(runs)
        .set({ flag: "flag{accepted}" })
        .where(eq(runs.id, run.id))
        .run()
      eventsLog.length = 0
      const refreshed = service.refresh(run.id)
      expect(refreshed?.hasFlag).toBe(true)
      expect(refreshed?.flag).toBe("flag{accepted}")
      expect(eventsLog.some((e) => e.type === "run.updated")).toBe(true)
      expect(service.get(run.id)?.hasFlag).toBe(true)
    } finally {
      cleanup()
    }
  })
})
