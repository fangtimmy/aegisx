import { describe, expect, mock, test } from "bun:test"

import { and, eq } from "drizzle-orm"

import type { HostAgentSession } from "../../src/agents/host-session"
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

type Db = ReturnType<typeof setupDb>

/**
 * A session that stays streaming (its prompt never settles) so the timeout
 * path sees a live agent. `abortResolves` selects the grace outcome:
 * true → abort clears streaming so the run settles within the grace and
 * stays warm (`outcome: 'idle'`); false → abort is a no-op, the run is still
 * streaming past the grace, gets SIGKILLed (`outcome: 'closed'`).
 */
function streamingSession(abortResolves: boolean): HostAgentSession {
  const session = {
    isStreaming: true,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: () => new Promise<void>(() => {}),
    abort: async () => {
      if (abortResolves) session.isStreaming = false
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => {},
  }
  return {
    session: session as never,
    sessionId: "sess-timeout",
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  } as unknown as HostAgentSession
}

/** Classic solver run whose prime lands on a streaming (never-settling)
 * session, so the run sits `running` at the deadline. */
async function createHangingRun(
  db: Db["db"],
  sqlite: Db["sqlite"],
  dir: string,
  abortResolves: boolean
) {
  seedEvent(db, "evt-1")
  seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
  const provider = makeProvider()
  const { manager, killed } = stubContainerManager()
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
    timeoutGraceMs: 40,
    createHost: mock(async () => streamingSession(abortResolves)),
  })
  const run = await runService.create({
    scopeType: "challenge" as const,
    challengeId: "ch-1",
    container: containerInput,
    timeoutMs: 30,
  })
  return { runService, run, manager, killed }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("run timeout", () => {
  test("deadline → abort → all settle within grace → run stays idle (warm), container kept", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      const { runService, run, killed } = await createHangingRun(
        db,
        sqlite,
        dir,
        true
      )
      // deadline(30ms) fires → abort clears streaming → grace(40ms) sees
      // nothing streaming → outcome idle, no teardown.
      await wait(150)

      const row = db.select().from(runs).where(eq(runs.id, run.id)).get()!
      expect(row.lastTimeoutAt).toBeTruthy()
      // Warm: container untouched, run not closed.
      expect(killed).toEqual([])
      expect(row.status).toBe("running")
      await runService.close()
    } finally {
      close()
    }
  })

  test("deadline → abort → still streaming past grace → SIGKILL → run closed", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      const { runService, run, killed } = await createHangingRun(
        db,
        sqlite,
        dir,
        false
      )
      await wait(150)

      const row = db.select().from(runs).where(eq(runs.id, run.id)).get()!
      expect(row.lastTimeoutAt).toBeTruthy()
      // Still streaming at the grace → teardown: container SIGTERM'd + closed.
      expect(killed).toContain(`aegisx-run-${run.id}`)
      expect(row.status).toBe("closed")
      await runService.close()
    } finally {
      close()
    }
  })

  test("run.timedOut wakes the event's scheduler with the outcome", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()
      const promptLog = new Map<string, string[]>()
      // First host creation = the scheduler's orchestrator (records prompts);
      // the challenge solver hangs so its run times out into `closed`.
      let hostCalls = 0
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
        timeoutGraceMs: 40,
        createHost: mock(async (input: { agentId: string }) => {
          hostCalls++
          if (hostCalls === 1) {
            const stub = stubHostAgentSession("sess-orch")
            const list: string[] = []
            promptLog.set(input.agentId, list)
            const sdk = stub.session as unknown as {
              prompt: (text: string) => Promise<void>
            }
            sdk.prompt = async (text: string) => {
              list.push(text)
            }
            return stub
          }
          return streamingSession(false)
        }),
      })

      const sched = await runService.create({
        scopeType: "event" as const,
        eventId: "evt-1",
        instruction: "",
        container: containerInput,
      })
      const orch = db
        .select()
        .from(agents)
        .where(and(eq(agents.runId, sched.id), eq(agents.slot, "orchestrator")))
        .get()!

      const challenge = await runService.create({
        scopeType: "challenge" as const,
        challengeId: "ch-1",
        container: containerInput,
        timeoutMs: 30,
      })
      await wait(150)

      const texts = promptLog.get(orch.id) ?? []
      expect(texts.some((t) => t.includes("timedOut(closed)"))).toBe(true)
      // P2 wire: the run exposes its hard deadline.
      expect(challenge.deadlineAt).not.toBeNull()
      await runService.close()
    } finally {
      close()
    }
  })
})
