import { describe, expect, test } from "bun:test"

import { spawnQueue } from "../../src/db/schema"
import { RunActionError } from "../../src/run/errors"
import {
  SYSTEM,
  USER,
  agentPrincipal,
  makeAgentService,
  seedAgent,
  seedChallenge,
  seedEvent,
} from "../helpers"

/** Two-event fixture: evt-1/ch-1 (solver-a, orch-1) vs evt-2/ch-2
 * (solver-b, orch-2). The canonical cross-event denial matrix lives here —
 * the assertions under test are the SERVICE-side scope layer
 * (run/principal-scope.ts + the channel identity rules), exercised directly
 * without any route or middleware in between. */
function twoEvents() {
  const h = makeAgentService({})
  seedEvent(h.db, "evt-2")
  seedChallenge(h.db, { id: "ch-2", eventId: "evt-2" })
  seedAgent(h.db, { id: "solver-a", eventId: "evt-1", challengeId: "ch-1" })
  seedAgent(h.db, {
    id: "orch-1",
    eventId: "evt-1",
    challengeId: null,
    role: "orchestrator",
  })
  seedAgent(h.db, { id: "solver-b", eventId: "evt-2", challengeId: "ch-2" })
  seedAgent(h.db, {
    id: "orch-2",
    eventId: "evt-2",
    challengeId: null,
    role: "orchestrator",
  })
  return h
}

const solverA = () => agentPrincipal("solver-a")
const orchA = () =>
  agentPrincipal("orch-1", { challengeId: null, role: "orchestrator" })

const forbidden = /无权|只能/

describe("service-layer scope denials (principal assertions)", () => {
  test("solver principal cannot remove another event's queue item (P0-8 class)", async () => {
    const h = twoEvents()
    try {
      const queue = h.service.queue()
      const foreign = queue.enqueue(
        { eventId: "evt-2", challengeId: "ch-2", source: "manual" },
        SYSTEM
      )
      // The event rule fires before any item lookup — even a bogus item id
      // is a forbidden, not a not_found.
      expect(() => queue.remove("evt-2", foreign.id, solverA())).toThrow(
        RunActionError
      )
      expect(() => queue.remove("evt-2", foreign.id, solverA())).toThrow(
        forbidden
      )
      // The victim item survives the denied removal.
      expect(
        h.db
          .select({ id: spawnQueue.id })
          .from(spawnQueue)
          .all()
          .map((row) => row.id)
      ).toContain(foreign.id)
      // The item's own-event orchestrator may remove it.
      const orchB = agentPrincipal("orch-2", {
        eventId: "evt-2",
        challengeId: null,
        role: "orchestrator",
      })
      expect(() => queue.remove("evt-2", foreign.id, orchB)).not.toThrow()
    } finally {
      await h.close()
    }
  })

  test("solver principal cannot post into another event's channels", async () => {
    const h = twoEvents()
    try {
      // team of evt-2's challenge: the identity rules reject the foreign
      // solver (not a member of ch-2, not evt-2's scheduler).
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "team:ch-2",
            author: { type: "agent", agentId: "solver-a" },
            body: "cross-event write",
          },
          solverA()
        )
      ).toThrow(RunActionError)
      // orch of evt-2: outside solver-a's event.
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "orch:evt-2",
            author: { type: "agent", agentId: "solver-a" },
            body: "cross-event write",
          },
          solverA()
        )
      ).toThrow(/不属于此 event/)
      // The same post into its OWN event's orch goes through.
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "orch:evt-1",
            author: { type: "agent", agentId: "solver-a" },
            body: "ask",
          },
          solverA()
        )
      ).not.toThrow()
    } finally {
      await h.close()
    }
  })

  test("a principal cannot claim another author face — user/system/agent mismatches all reject (P0-1 class)", async () => {
    const h = twoEvents()
    try {
      // An agent principal claiming the USER author face: rejected by the
      // identity-consistency assertion, not by any route gate.
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "team:ch-1",
            author: { type: "user" },
            body: "impersonation",
          },
          solverA()
        )
      ).toThrow(/user 帖面/)
      // An agent principal claiming the SYSTEM face: rejected.
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "team:ch-1",
            author: { type: "system" },
            body: "impersonation",
          },
          solverA()
        )
      ).toThrow(/system 身份/)
      // An agent principal signing ANOTHER agent's name: rejected.
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "team:ch-1",
            author: { type: "agent", agentId: "solver-b" },
            body: "spoofed",
          },
          solverA()
        )
      ).toThrow(/token 不符/)
      // The user principal posting as user stays the legitimate face.
      expect(() =>
        h.service.channels.post(
          {
            channelKey: "team:ch-1",
            author: { type: "user" },
            body: "hello",
          },
          USER
        )
      ).not.toThrow()
    } finally {
      await h.close()
    }
  })

  test("solver principal cannot stop another agent; its own agent and the user face still work", async () => {
    const h = twoEvents()
    try {
      // Foreign solver (same event even): forbidden for a solver principal.
      seedAgent(h.db, {
        id: "solver-a2",
        eventId: "evt-1",
        challengeId: "ch-1",
      })
      await expect(h.service.stopAgent("solver-a2", solverA())).rejects.toThrow(
        forbidden
      )
      // Cross-event agent: forbidden for the scheduler principal too.
      await expect(h.service.stopAgent("solver-b", orchA())).rejects.toThrow(
        forbidden
      )
      // The solver's OWN agent: allowed (self face).
      await expect(
        h.service.stopAgent("solver-a", solverA())
      ).resolves.toMatchObject({ id: "solver-a" })
      // The user principal keeps full authority.
      await expect(
        h.service.stopAgent("solver-b", USER)
      ).resolves.toMatchObject({ id: "solver-b" })
    } finally {
      await h.close()
    }
  })
})
