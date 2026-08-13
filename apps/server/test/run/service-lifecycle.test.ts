import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import type { AgentHostInput } from "../../src/agents/host"
import { agents, runs } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
  flatSettings,
  makeProvider,
  seedChallenge,
  seedEvent,
  seedRun,
  setupDb,
  stubConfigStore,
  stubContainerManager,
  stubHostAgentSession,
  toConnection,
  now,
} from "../helpers"

const containerInput = {
  image: "aegisx/solve:latest",
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  tmpfsSize: "128m",
  workspace: "/workspace",
}

function baseCreateInput(
  challengeId: string,
  provider: ReturnType<typeof makeProvider>
) {
  return {
    challengeId,
    provider: toConnection(provider),
    modelId: "model-1",
    thinkingLevel: "off" as const,
    container: containerInput,
  }
}

/** A stub host whose prompt resolves after a tick, and whose isStreaming flips
 * true while a turn is notionally in flight (so the service observes a running
 * → idle transition through the SQL-derived status). */
function stubHostFlipping(sessionId = "sess-1") {
  let streaming = false
  const session = {
    isStreaming: false,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: async () => {
      streaming = true
      session.isStreaming = true
      await Promise.resolve()
      session.isStreaming = false
    },
    abort: async () => {
      session.isStreaming = false
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => {},
  }
  return {
    session: session as never,
    sessionId,
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  } as unknown as import("../../src/agents/host-session").HostAgentSession
}

describe("run lifecycle (v8)", () => {
  test("run status is SQL-derived: a streaming entry agent → running", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const createHost = mock(async () =>
        stubHostAgentSession("sess-1", { hang: true })
      )

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
        getSettings: flatSettings,
        createHost,
      })

      const run = await runService.create(baseCreateInput("ch-1", provider))
      // hang → prompt pending → agentTurnStart fired → run derived 'running'
      expect(run.status).toBe("running")
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .get()
      expect(agent?.status).toBe("running")
      await runService.close()
    } finally {
      close()
    }
  })

  test("run status is SQL-derived: a settled entry agent → idle", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const createHost = mock(async () => stubHostFlipping("sess-1"))

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
        getSettings: flatSettings,
        createHost,
      })

      const run = await runService.create(baseCreateInput("ch-1", provider))
      // The flipping stub's prompt resolves synchronously, so the turn settles
      // and the aggregate SQL derives 'idle'.
      await new Promise((r) => setTimeout(r, 5))
      const row = db.select().from(runs).where(eq(runs.id, run.id)).get()
      expect(row?.status).toBe("idle")
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.runId, run.id))
        .get()
      expect(agent?.status).toBe("idle")
      await runService.close()
    } finally {
      close()
    }
  })

  test("finish tears the run down (closed + finished stamp + summary)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const createHost = mock(async () => stubHostFlipping("sess-1"))

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
        getSettings: flatSettings,
        createHost,
      })

      const run = await runService.create(baseCreateInput("ch-1", provider))
      await new Promise((r) => setTimeout(r, 5))
      const finished = await runService.finish(run.id, "solved it")
      expect(finished.status).toBe("closed")
      const row = db.select().from(runs).where(eq(runs.id, run.id)).get()
      expect(row?.status).toBe("closed")
      expect(row?.summary).toBe("solved it")
      expect(row?.completedAt).not.toBeNull()
      await runService.close()
    } finally {
      close()
    }
  })

  test("recoverOnBoot marks running/idle runs closed and their agents idle", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      seedRun(db, { id: "r-1", status: "running" })
      db.insert(agents)
        .values({
          id: "a-1",
          runId: "r-1",
          slot: "solver",
          role: "solver",
          isEntry: true,
          provider: "Test Provider",
          modelId: "test-model",
          thinkingLevel: "off",
          systemPrompt: "sp",
          tools: "[]",
          status: "running",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

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
        configStore: stubConfigStore([makeProvider()]),
        getSettings: flatSettings,
        createHost: async () => stubHostAgentSession(),
      })

      await runService.recoverOnBoot()
      const row = db.select().from(runs).where(eq(runs.id, "r-1")).get()
      expect(row?.status).toBe("closed")
      const agent = db.select().from(agents).where(eq(agents.id, "a-1")).get()
      expect(agent?.status).toBe("idle")
      await runService.close()
    } finally {
      close()
    }
  })

  test("cold-restore reuses the agent row's systemPrompt/model snapshot (no re-render)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // A closed run with an entry agent carrying an edited prompt + per-agent model.
      seedRun(db, {
        id: "r-1",
        status: "closed",
        challengeId: "ch-1",
        eventId: "evt-1",
      })
      db.insert(agents)
        .values({
          id: "a-1",
          runId: "r-1",
          slot: "solver",
          role: "solver",
          isEntry: true,
          provider: "Test Provider",
          providerLabel: "Test Provider",
          modelId: "gpt-4o-mini",
          modelLabel: "Test Model",
          thinkingLevel: "off",
          systemPrompt: "EDITED-SNAPSHOT-PROMPT",
          tools: JSON.stringify(["finish_run", "submit_flag"]),
          status: "idle",
          sessionFile: "sess-edited",
          name: "Solver",
          createdAt: now(),
          updatedAt: now(),
        })
        .run()

      const { manager } = stubContainerManager()
      const captured: AgentHostInput[] = []
      const createHost = mock(async (input: AgentHostInput) => {
        captured.push(input)
        return stubHostFlipping(input.agentId)
      })
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
        configStore: stubConfigStore([makeProvider()]),
        getSettings: flatSettings,
        createHost,
      })

      // Messaging a closed run cold-restores its entry agent, then sends.
      await runService.sendMessage("r-1", { text: "ping" })
      await new Promise((r) => setTimeout(r, 5))

      expect(captured).toHaveLength(1)
      expect(captured[0]!.agentId).toBe("a-1")
      // Snapshot reused verbatim — the edited prompt survives, no re-render.
      expect(captured[0]!.systemPrompt).toBe("EDITED-SNAPSHOT-PROMPT")
      await runService.close()
    } finally {
      close()
    }
  })
})
