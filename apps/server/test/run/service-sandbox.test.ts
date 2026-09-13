import { describe, expect, mock, test } from "bun:test"

import { eq } from "drizzle-orm"

import { agents } from "../../src/db/schema"
import {
  agentContainerName,
  orchestratorContainerName,
} from "../../src/run/workspace-resolver"
import {
  makeAgentService,
  promptRecordingHost,
  seedAgent,
  statefulContainerManager,
  stubContainerManager,
  stubHostAgentSession,
  USER,
} from "../helpers"
import { refine } from "../support"

/** Recording manager whose `list` reports crash leftovers under our naming
 * prefixes (plus an unrelated box the sweep must not touch). */
function orphanedContainerManager() {
  const { manager, removed } = stubContainerManager()
  const orphans = [
    "aegisx-agent-deadbeef",
    "aegisx-agent-cafebabe",
    "aegisx-orch-12345678",
    "unrelated-box",
  ]
  const listed: string[] = []
  const sweeper = {
    ...manager,
    list: async (prefix: string) => {
      listed.push(prefix)
      return orphans.filter((name) => name.startsWith(prefix))
    },
  }
  return { manager: sweeper, removed, listed }
}

describe("per-agent one-shot sandboxes", () => {
  test("solver containers are per-agent and carry the challenge cache volume binds", async () => {
    const { manager, created } = statefulContainerManager()
    const h = makeAgentService({
      containerManager: manager,
      createHost: mock(async () => stubHostAgentSession()),
    })
    try {
      const [a, b] = await Promise.all([
        h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER),
        h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER),
      ])
      expect(created).toHaveLength(2)
      const optsList = created.map((opts) =>
        refine<{ name: string; binds: string[] }>(opts)
      )
      // One named sandbox per agent.
      expect(optsList.map((o) => o.name).toSorted()).toEqual(
        [a.id, b.id].map(agentContainerName).toSorted()
      )
      // Both bind the same challenge cache volume at the two mount points.
      for (const opts of optsList) {
        expect(opts.binds[0]).toContain(":/workspace")
        expect(opts.binds).toContain(
          "aegisx-ch-cache-ch-1:/var/cache/apt/archives"
        )
        expect(opts.binds).toContain("aegisx-ch-cache-ch-1:/opt/aegisx-cache")
      }
    } finally {
      await h.close()
    }
  })

  test("the scheduler sandbox keeps the /challenges:ro mount and gets no cache volume", async () => {
    const { manager, created } = statefulContainerManager()
    const h = makeAgentService({
      containerManager: manager,
      createHost: mock(async () => stubHostAgentSession()),
    })
    try {
      await h.service.startScheduler("evt-1")
      expect(created).toHaveLength(1)
      const opts = refine<{
        name: string
        binds: string[]
        extraBinds: string[]
      }>(created[0])
      expect(opts.name).toBe(orchestratorContainerName("evt-1"))
      expect(opts.binds.some((bind) => bind.includes("ch-cache"))).toBe(false)
      expect(
        opts.extraBinds.some((bind) => bind.endsWith(":/challenges:ro"))
      ).toBe(true)
    } finally {
      await h.close()
    }
  })

  test("terminal close destroys the agent's sandbox; reopen prepares a fresh one", async () => {
    const { manager, created, removed } = statefulContainerManager()
    const h = makeAgentService({
      containerManager: manager,
      createHost: mock(async () => stubHostAgentSession()),
    })
    try {
      const agent = await h.service.spawn(
        { eventId: "evt-1", challengeId: "ch-1" },
        USER
      )
      expect(created).toHaveLength(1)
      expect(removed).toEqual([])

      await h.service.closeAgent(agent.id, USER)
      // settle = destroy: ONE remove(force) named after the agent.
      expect(removed).toEqual([agentContainerName(agent.id)])

      // Reopen rebuilds: a fresh prepare creates the sandbox again.
      await h.service.sendMessage(agent.id, { text: "wake" }, USER)
      expect(created).toHaveLength(2)
      expect(refine<{ name: string }>(created[1]).name).toBe(
        agentContainerName(agent.id)
      )
    } finally {
      await h.close()
    }
  })

  test("closing the scheduler destroys the per-event orchestrator sandbox", async () => {
    const { manager, removed } = statefulContainerManager()
    const h = makeAgentService({
      containerManager: manager,
      createHost: mock(async () => stubHostAgentSession()),
    })
    try {
      await h.service.startScheduler("evt-1")
      const sched = await h.service.closeScheduler("evt-1")
      expect(removed).toEqual([orchestratorContainerName("evt-1")])
      expect(sched.status).toBe("aborted")
    } finally {
      await h.close()
    }
  })

  test("a spawn that fails after the sandbox build still reclaims it (no runtime leaked)", async () => {
    const { manager, created, removed } = statefulContainerManager()
    const h = makeAgentService({
      containerManager: manager,
      createHost: mock(async () => {
        throw new Error("session boom")
      }),
    })
    try {
      await expect(
        h.service.spawn({ eventId: "evt-1", challengeId: "ch-1" }, USER)
      ).rejects.toThrow(/session boom/)
      const row = h.db.select().from(agents).all().at(-1)!
      expect(row.status).toBe("failed")
      expect(created).toHaveLength(1)
      expect(removed).toEqual([agentContainerName(row.id)])
    } finally {
      await h.close()
    }
  })

  test("boot sweep removes every orphan under the aegisx-agent-/aegisx-orch- prefixes", async () => {
    const { manager, removed, listed } = orphanedContainerManager()
    const h = makeAgentService({ containerManager: manager })
    try {
      seedAgent(h.db, {
        id: "ag-live",
        eventId: "evt-1",
        challengeId: "ch-1",
        status: "running",
      })
      await h.service.recoverOnBoot()
      // Both prefixes scanned, every reported orphan removed, unrelated
      // names untouched, volumes (caches) kept.
      expect(listed).toEqual(["aegisx-agent-", "aegisx-orch-"])
      expect(removed.toSorted()).toEqual([
        "aegisx-agent-cafebabe",
        "aegisx-agent-deadbeef",
        "aegisx-orch-12345678",
      ])
    } finally {
      await h.close()
    }
  })

  test("service close disposes but does NOT destroy — the boot sweep owns strays", async () => {
    const { manager, removed } = statefulContainerManager()
    const h = makeAgentService({
      containerManager: manager,
      createHost: promptRecordingHost(new Map()),
    })
    const agent = await h.service.spawn(
      { eventId: "evt-1", challengeId: "ch-1" },
      USER
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      h.db.select().from(agents).where(eq(agents.id, agent.id)).get()!.status
    ).toBe("idle")
    await h.close()
    expect(removed).toEqual([])
  })
})
