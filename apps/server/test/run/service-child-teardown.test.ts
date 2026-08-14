import { describe, expect, mock, test } from "bun:test"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { and, eq } from "drizzle-orm"

import type { AgentHostInput } from "../../src/agents/host"
import { agents } from "../../src/db/schema"
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

/**
 * A child host session whose prompt hangs until abort() rejects it — the
 * shape of a real in-flight child turn when the run is torn down.
 */
function hangUntilAbortedSession() {
  let rejectPrompt: (error: Error) => void = () => {}
  const session = {
    isStreaming: true,
    thinkingLevel: "off",
    modelRuntime: {},
    prompt: () =>
      new Promise<never>((_resolve, reject) => (rejectPrompt = reject)),
    abort: () => {
      session.isStreaming = false
      rejectPrompt(new Error("aborted by run teardown"))
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => {},
  }
  return {
    session: session as never,
    sessionId: "sess-child",
    pipeline: { attach: () => () => {}, detach: () => {} },
    dispose: async () => {},
  } as unknown as import("../../src/agents/host-session").HostAgentSession
}

describe("child settle vs external teardown (code-review P1.3)", () => {
  test("closing a run mid-child-turn leaves the child idle (settle not overwritten)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      const provider = makeProvider()
      const { manager } = stubContainerManager()

      let entryTools: ToolDefinition[] = []
      const createHost = mock(async (input: AgentHostInput) => {
        if (input.agentId.startsWith("child-")) {
          return hangUntilAbortedSession()
        }
        entryTools = input.extraTools ?? []
        return stubHostAgentSession("sess-entry", { hang: true })
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
        configStore: stubConfigStore([provider]),
        getSettings: flatSettingsWithDefaultModel,
        createHost,
      })

      const run = await runService.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })

      // Simulate the solver invoking spawn_agent (its session is stubbed, so
      // drive the tool directly with the snapshot the host received).
      const spawnTool = entryTools.find((t) => t.name === "spawn_agent")
      expect(spawnTool).toBeDefined()
      await spawnTool!.execute(
        "id",
        { name: "Recon", task: "probe the box" } as never,
        undefined,
        undefined,
        undefined as never
      )
      const child = db
        .select()
        .from(agents)
        .where(and(eq(agents.runId, run.id), eq(agents.role, "child")))
        .get()!
      expect(child.status).toBe("running")

      // Close the run while the child is streaming: teardown aborts + disposes
      // the child session and removes it from childSessions.
      await runService.closeRun(run.id)
      // Let the aborted child's prompt rejection settle in runInBackground.
      await new Promise((resolve) => setTimeout(resolve, 10))

      const after = db
        .select()
        .from(agents)
        .where(eq(agents.id, child.id))
        .get()!
      // The teardown's idle write wins; the late settle must NOT flip to failed.
      expect(after.status).toBe("idle")
      expect(after.error).toBeNull()
      await runService.close()
    } finally {
      close()
    }
  })
})
