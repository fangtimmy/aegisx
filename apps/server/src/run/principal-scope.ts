import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { challenges } from "../db/schema"
import type { Principal } from "../infrastructure/agent-auth"
import { RunActionError } from "./errors"

/**
 * Data-level scope assertions (layer 2 of 2). The middleware verdict
 * (infrastructure/agent-auth.ts) decides whether a KIND of principal may hit
 * an ENDPOINT at all; these helpers decide whether THIS principal may touch
 * THIS piece of data. Every cross-principal service method funnels its scope
 * check through one of them, so "one more branch that forgets the condition"
 * (the P0-1/2/8 root cause) is structurally impossible — the routes carry no
 * scope logic and the assertions are the only place these rules exist.
 *
 * user/system principals are unrestricted (the local user face and
 * in-process callers); agent principals are confined to their own event,
 * solvers further to their own agent.
 */

const deny = (message: string) => new RunActionError("forbidden", message)

/** Event-scoped data: an agent principal may only touch its own event. */
export function assertMayTouchEvent(
  principal: Principal,
  eventId: string
): void {
  if (principal.kind !== "agent") return
  if (principal.eventId !== eventId) {
    throw deny(
      `agent ${principal.agentId} 属于赛事 ${principal.eventId}，无权操作赛事 ${eventId} 的数据`
    )
  }
}

/** Challenge-scoped data: resolves the challenge's owning event, then applies
 * the event rule. A missing challenge row is left to the caller's own
 * not_found handling. */
export function assertMayTouchChallenge(
  db: Database,
  principal: Principal,
  challengeId: string
): void {
  if (principal.kind !== "agent") return
  const row = db
    .select({ eventId: challenges.eventId })
    .from(challenges)
    .where(eq(challenges.id, challengeId))
    .get()
  if (row) assertMayTouchEvent(principal, row.eventId)
}

/** The agent-management face: a solver may only act on itself; a scheduler
 * (orchestrator) on any agent of its own event. Mirrors the verdict's
 * endpoint rules at the data level, so direct service calls are guarded too. */
export function assertMayTouchAgent(
  principal: Principal,
  agent: { id: string; eventId: string }
): void {
  if (principal.kind !== "agent") return
  if (principal.role === "solver") {
    if (principal.agentId !== agent.id) {
      throw deny(
        `solver 只能操作自己的 agent（${principal.agentId} ≠ ${agent.id}）`
      )
    }
    return
  }
  assertMayTouchEvent(principal, agent.eventId)
}
