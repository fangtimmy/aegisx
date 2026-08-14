import { describe, expect, mock, test } from "bun:test"

import { defaultSettings } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import { runs } from "../../src/db/schema"
import { createRunService } from "../../src/run/service"
import {
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

/** flatSettings with a configurable challenge-run cap + a resolvable model. */
function settingsWithCap(maxConcurrentRuns: number) {
  return {
    ...defaultSettings(),
    "agent.defaultModelId": "openai/gpt-4o-mini:off",
    "scheduler.maxConcurrentRuns": maxConcurrentRuns,
  }
}

/** Host sessions hang on the createHost calls whose 0-based index is in
 * `hangCalls` (create is sequential: run B's prime = call 0, run A's = call 1).
 * Hanging keeps the run deterministically `running`; resolving settles it to
 * `idle` (warm). */
function makeService(
  db: ReturnType<typeof setupDb>["db"],
  sqlite: ReturnType<typeof setupDb>["sqlite"],
  dir: string,
  opts: { cap: number; hangCalls: number[] }
) {
  const provider = makeProvider()
  const { manager } = stubContainerManager()
  const promptLog = new Map<string, string[]>()
  let callIndex = 0
  return {
    service: createRunService({
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
      getSettings: () => settingsWithCap(opts.cap),
      createHost: mock(async (input: { agentId: string }) => {
        const index = callIndex++
        const hang = opts.hangCalls.includes(index)
        const stub = stubHostAgentSession("sess-" + input.agentId.slice(0, 6), {
          hang,
        })
        const list: string[] = []
        promptLog.set(input.agentId, list)
        const sdk = stub.session as unknown as {
          prompt: (text: string) => Promise<void>
        }
        // Instrument the prompt but preserve the hang semantics (a resolving
        // override would settle the run back to idle immediately).
        sdk.prompt = (text: string) => {
          list.push(text)
          return hang ? new Promise(() => {}) : Promise.resolve()
        }
        return stub
      }),
    }),
    promptLog,
  }
}

const runStatus = (db: ReturnType<typeof setupDb>["db"], runId: string) =>
  db.select().from(runs).where(eq(runs.id, runId)).get()!.status

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("fresh-turn capacity gate (code-review P3.1)", () => {
  test("waking a warm idle run is fence-checked: rejected at cap, admitted after a slot frees", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Call 0 (run B prime) resolves → B warms idle; call 1 (run A prime)
      // hangs → A holds the only slot.
      const { service, promptLog } = makeService(db, sqlite, dir, {
        cap: 1,
        hangCalls: [1],
      })

      const runB = await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      expect(runStatus(db, runB.id)).toBe("idle")

      const runA = await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      expect(runStatus(db, runA.id)).toBe("running")

      // A fresh turn on warm-idle B is a new compute round → capacity reject.
      await expect(
        service.sendMessage(runB.id, { text: "wake" })
      ).rejects.toThrow(/Concurrency cap/)
      // The reject leaves B idle (the placeholder flip never happened) and the
      // message was never driven.
      expect(runStatus(db, runB.id)).toBe("idle")
      const bAgent = service.listAgents(runB.id)[0]!
      expect(promptLog.get(bAgent.id)).not.toContain("wake")

      // Free the slot → the same message is admitted (turn driven, then the
      // resolving host settles the run back to idle).
      await service.closeRun(runA.id)
      await service.sendMessage(runB.id, { text: "wake" })
      await settle()
      expect(promptLog.get(bAgent.id)).toContain("wake")
      expect(runStatus(db, runB.id)).toBe("idle")
      await service.close()
    } finally {
      close()
    }
  })

  test("steer into a streaming turn bypasses the gate (in-flight turns are never capacity-rejected)", async () => {
    const { db, sqlite, dir, close } = setupDb()
    try {
      seedEvent(db, "evt-1")
      seedChallenge(db, { id: "ch-1", eventId: "evt-1" })
      // Cap 2: both runs stream (hanging primes); the cap is then full.
      const { service } = makeService(db, sqlite, dir, {
        cap: 2,
        hangCalls: [0, 1],
      })

      const runA = await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      const runB = await service.create({
        scopeType: "challenge",
        challengeId: "ch-1",
        container: containerInput,
      })
      await settle()
      expect(runStatus(db, runA.id)).toBe("running")
      expect(runStatus(db, runB.id)).toBe("running")

      // Cap is full (2/2 running); steering into B's in-flight turn must pass
      // (the streaming branch never consults the gate).
      await expect(
        service.sendMessage(runB.id, {
          text: "nudge",
          deliverAs: "steer",
        })
      ).resolves.toBeDefined()
      await service.close()
    } finally {
      close()
    }
  })
})
