import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents, runs } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettingsWithDefaultModel,
  makeProvider,
  seedChallenge,
  seedEvent,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
} from "../helpers"

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("scheduler event wiring (spec §3.5)", () => {
  test("challenge run going idle wakes the scheduler's orchestrator", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      // Record every prompt text per agent (prime + event wake-ups).
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      // A challenge run in the same event: its prime settle flips it to idle,
      // which must wake the scheduler's orchestrator.
      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      // Scheduler prime, then the run.started + run.idle wake-ups.
      expect(texts.length).toBeGreaterThanOrEqual(3)
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("已启动"))
      ).toBe(true)
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("idle"))
      ).toBe(true)
      // The orchestrator's wake-up turn settled → scheduler run is idle again.
      expect(runService.get(sched.id)!.status).toBe("idle")
      await runService.close()
    } finally {
      close()
    }
  })

  test("accepted flag notifies the scheduler (run.flagAccepted)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      // A real challenge run in the same event (emitRunEvent requires the run
      // row to exist; it only forwards challenge-scoped runs to the scheduler).
      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      runService.notifyFlagAccepted(challenge.id)
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("flag"))
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })

  test("finished run notifies the scheduler (run.finished)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      // Force-finish the challenge run → teardownRun emits run.finished, which
      // must wake the scheduler's orchestrator (a finish_run run never settles
      // idle, so run.idle alone would leave the scheduler blind).
      await runService.finish(challenge.id, "solved it")
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("已完成"))
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })

  test("failed turn reports failure to the scheduler (run.idle failed)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            // Challenge solvers fail their turn; the scheduler's own agent
            // stays healthy so it can receive the failure wake-up.
            const agentRow = db
              .select()
              .from(agents)
              .where(eq(agents.id, input.agentId))
              .get()
            const runRow = agentRow
              ? db.select().from(runs).where(eq(runs.id, agentRow.runId)).get()
              : undefined
            if (runRow?.scopeType === "challenge") throw new Error("boom")
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      // The solver's failed prime settle flips the run idle — the wake-up
      // must carry the failure marker so the orchestrator does not treat the
      // run as a healthy pause.
      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("失败"))
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })

  test("cold-resumed run notifies the scheduler (run.resumed)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()

      // Close the challenge run, then cold-resume it with a message — the
      // restore must wake the scheduler so it re-evaluates the run.
      await runService.finish(challenge.id, "done")
      await settle()
      await runService.sendMessage(challenge.id, { text: "继续" })
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("已恢复"))
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })

  test("closed scheduler run cold-restores via message (history + wiring preserved)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "focus crypto",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      // Close the scheduler: container released, event wiring torn down.
      await runService.closeRun(sched.id)
      expect(runService.get(sched.id)!.status).toBe("closed")

      // Messaging the orchestrator cold-restores the SAME run (history kept)
      // and re-wires the event subscriptions — no fresh start required.
      await runService.sendAgentMessage(orch.id, { text: "继续" })
      await settle()
      expect(runService.get(sched.id)!.id).toBe(sched.id)
      expect(runService.get(sched.id)!.status).toBe("idle")
      const texts = promptLog.get(orch.id) ?? []
      expect(texts.some((t) => t.includes("继续"))).toBe(true)

      // Wiring rebuilt: a challenge run going idle wakes the restored
      // scheduler's orchestrator.
      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      const after = promptLog.get(orch.id) ?? []
      expect(
        after.some((t) => t.includes(challenge.id) && t.includes("idle"))
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })

  test("paused scheduler drops run events; resume re-enables (W3.1)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.startScheduler("evt-1")
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!
      const textsBefore = promptLog.get(orch.id)?.length ?? 0

      // Pause → the scheduler run is stopped warm and its run-lifecycle
      // events are dropped before they reach the orchestrator.
      await runService.pauseScheduler("evt-1")
      const challenge = await runService.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      runService.notifyFlagAccepted(challenge.id)
      await settle()
      const textsPaused = promptLog.get(orch.id) ?? []
      expect(textsPaused.length).toBe(textsBefore) // silent — no wake-ups

      // Resume → the orchestrator is woken with the re-sync instruction.
      await runService.resumeScheduler("evt-1")
      await settle()
      const textsResumed = promptLog.get(orch.id) ?? []
      expect(textsResumed.length).toBeGreaterThan(textsBefore)
      expect(textsResumed.some((t) => t.includes("重新同步"))).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })

  test("start on a closed scheduler run cold-restores (memory kept); reset recreates (W3.2)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.startScheduler("evt-1")
      await settle()
      const schedId = sched.id
      const orchId = db
        .select()
        .from(agents)
        .where(eq(agents.runId, schedId))
        .get()!.id

      await runService.closeRun(schedId)
      expect(runService.get(schedId)!.status).toBe("closed")

      // Default start = restore: SAME run id back live, agent row NOT rebuilt.
      const restored = await runService.startScheduler("evt-1")
      await settle()
      expect(restored.id).toBe(schedId)
      expect(restored.status).toBe("idle")
      const orchAfter = db
        .select()
        .from(agents)
        .where(eq(agents.runId, schedId))
        .get()!
      expect(orchAfter.id).toBe(orchId)

      // reset=true: the closed run is deleted (cascade) and a fresh one made.
      await runService.closeRun(schedId)
      const fresh = await runService.startScheduler("evt-1", { reset: true })
      await settle()
      expect(fresh.id).not.toBe(schedId)
      expect(runService.get(schedId)).toBeUndefined()
      await runService.close()
    } finally {
      close()
    }
  })

  test("manual launches wake the scheduler with source=manual (W5)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const promptLog = new Map<string, string[]>()
      const { manager } = stubContainerManager()
      const runService = createRunService({
        db,
        sqlite,
        dataDir: dir,
        containerManager: manager,
        platformService: {
          submitFlag: async () => undefined,
          targetAction: async () => ({
            status: "running",
            endpoints: [],
            expiresAt: null,
          }),
        } as never,
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost: mock(async (input: { agentId: string }) => {
          const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6))
          const list: string[] = []
          promptLog.set(input.agentId, list)
          const sdk = stub.session as unknown as {
            prompt: (text: string) => Promise<void>
          }
          sdk.prompt = async (text: string) => {
            list.push(text)
          }
          return stub
        }),
      })

      const sched = await runService.create({
        scopeType: "event",
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      await settle()
      const orch = db
        .select()
        .from(agents)
        .where(eq(agents.runId, sched.id))
        .get()!

      // A manual challenge run (source defaults to manual) — the wake-up must
      // carry the manual marker so the scheduler does not operate on it.
      const challenge = await runService.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
        source: "manual",
      })
      await settle()

      const texts = promptLog.get(orch.id) ?? []
      expect(
        texts.some((t) => t.includes(challenge.id) && t.includes("手动启动"))
      ).toBe(true)

      // A scheduler-launched run (source=scheduler) carries NO manual marker —
      // the scheduler owns it and may operate on it.
      const schedRun = await runService.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
        source: "scheduler",
      })
      await settle()
      const textsAfter = promptLog.get(orch.id) ?? []
      expect(
        textsAfter.some(
          (t) =>
            t.includes(schedRun.id) &&
            t.includes("已启动") &&
            !t.includes("手动启动")
        )
      ).toBe(true)
      await runService.close()
    } finally {
      close()
    }
  })
})
