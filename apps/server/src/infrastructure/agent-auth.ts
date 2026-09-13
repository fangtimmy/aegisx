import { and, eq, ne } from "drizzle-orm"
import type { Context, MiddlewareHandler } from "hono"

import type { Database } from "../db"
import { agents, challenges } from "../db/schema"
import { jsonError } from "./http-errors"

/** The authenticated agent identity, derived from the bearer token — never
 * from client-reported headers. */
export type AgentPrincipal = {
  kind: "agent"
  agentId: string
  eventId: string
  challengeId: string | null
  role: "solver" | "orchestrator"
}

/**
 * Request identity, resolved exactly once (by the {@link agentAuth}
 * middleware for HTTP, by hand for in-process callers) and passed down into
 * service methods. Scope enforcement lives in the service layer via the
 * assertion helpers in run/principal-scope.ts; this type is the only thing
 * they accept.
 *
 *  - user: a tokenless request — the localhost user/UI face, full authority.
 *  - agent: a valid bearer token; confined to its own event (solvers further
 *    to their own agent) by the scope assertions.
 *  - system: in-process internal callers only (flag pipeline, notices,
 *    bootstrap) — full authority. The middleware never produces it, so no
 *    HTTP request can claim it.
 */
export type Principal = { kind: "user" } | { kind: "system" } | AgentPrincipal

/** Spawn-time credential (64 hex). Injected per-exec as AEGISX_TOKEN. */
export function newAgentToken(): string {
  return (
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "")
  )
}

type Verdict = { ok: true } | { ok: false; reason: string }

const deny = (reason: string): Verdict => ({ ok: false, reason })

function agentEventOf(db: Database, agentId: string): string | null {
  const row = db
    .select({ eventId: agents.eventId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  return row?.eventId ?? null
}

function challengeEventOf(db: Database, challengeId: string): string | null {
  const row = db
    .select({ eventId: challenges.eventId })
    .from(challenges)
    .where(eq(challenges.id, challengeId))
    .get()
  return row?.eventId ?? null
}

/**
 * Endpoint-level gate (layer 1 of 2): which KINDS of principal may hit which
 * route shape at all. Data-level scope ("may this principal touch this row")
 * is layer 2 — the service-side assertions in run/principal-scope.ts. The
 * complete agent-API surface lives here: a request carrying an agent token
 * may ONLY reach routes this returns ok for — the user-facing API (events/
 * challenges CRUD, providers, settings, platforms, scheduler policy) is 403
 * by omission. Solver = the self face + channels; scheduler = the management
 * face of its own event + channels.
 */
function verdict(
  db: Database,
  method: string,
  path: string,
  p: AgentPrincipal
): Verdict {
  const seg = path.split("?")[0].split("/").filter(Boolean)
  const [, area, id, sub, leaf] = seg
  const isScheduler = p.role === "orchestrator"

  // Channels face (both roles): visibility and identity are enforced inside
  // the channel service (readForAgent / resolveAuthor use the principal).
  if (area === "channels" && id !== undefined && sub === "messages") {
    if (method === "GET" || method === "POST") return { ok: true }
    return deny("channels face is read/post only")
  }

  if (area === "agents" && id !== undefined) {
    // Solver: only its own detail / messages / channels list.
    if (!isScheduler) {
      const bareSelf = sub === undefined && method === "GET"
      const subSelf =
        (sub === "messages" || sub === "channels") &&
        leaf === undefined &&
        method === "GET"
      if (id === p.agentId && (bareSelf || subSelf)) return { ok: true }
      return deny("solvers may only read their own agent face; use channels")
    }
    // Scheduler: full agent management, own event only.
    const targetEvent = agentEventOf(db, id)
    if (targetEvent !== null && targetEvent !== p.eventId) {
      return deny("agent belongs to a different event")
    }
    return { ok: true }
  }

  if (isScheduler && area === "events" && id === p.eventId) {
    if (seg.length === 3 && method === "GET") return { ok: true }
    if (sub === "fleet" && seg.length === 4 && method === "GET") {
      return { ok: true }
    }
    if (sub === "scheduler" && seg.length === 4 && method === "GET") {
      return { ok: true }
    }
    // The typed-plan surface (control-plane §B): scheduler-only, own event.
    if (sub === "plan" && seg.length === 4 && method === "POST") {
      return { ok: true }
    }
    if (sub === "queue") {
      if (seg.length === 4 && (method === "GET" || method === "POST")) {
        return { ok: true }
      }
      if (
        seg.length === 5 &&
        ((method === "POST" &&
          (leaf === "clear" ||
            leaf === "reorder" ||
            leaf === "pause" ||
            leaf === "resume")) ||
          (method === "DELETE" && leaf !== undefined))
      ) {
        return { ok: true }
      }
    }
  }

  if (isScheduler && area === "challenges" && id !== undefined) {
    const challengeEvent = challengeEventOf(db, id)
    if (challengeEvent === null || challengeEvent !== p.eventId) {
      return deny("challenge belongs to a different event")
    }
    if (seg.length === 3 && method === "GET") return { ok: true }
    if (sub === "agents" && seg.length === 4 && method === "POST") {
      return { ok: true }
    }
  }

  return deny("this endpoint is not part of the agent API surface")
}

/**
 * Global middleware: resolves the {@link Principal} once per request. A
 * bearer token resolves to an agent principal, gated to the agent API
 * surface by verdict; tokenless requests become the user principal and pass
 * through untouched (the unauthenticated localhost boundary is documented
 * and accepted). Routes read it back via principalOf and hand it to the
 * service layer.
 */
export function agentAuth(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization")
    if (!header?.startsWith("Bearer ")) {
      setPrincipal(c, { kind: "user" })
      return await next()
    }
    const token = header.slice(7).trim()
    const row = token
      ? db
          .select({
            id: agents.id,
            eventId: agents.eventId,
            challengeId: agents.challengeId,
            role: agents.role,
          })
          .from(agents)
          // The redundant token != '' term is load-bearing: the partial index
          // agents_token_unique only covers non-empty tokens, and SQLite will
          // not use a partial index unless the query implies its WHERE clause
          // (an empty bearer already short-circuits above).
          .where(and(eq(agents.token, token), ne(agents.token, "")))
          .get()
      : undefined
    if (!row) {
      return jsonError(
        c,
        { code: "unauthorized", message: "Invalid or unknown agent token" },
        401
      )
    }
    const principal: AgentPrincipal = {
      kind: "agent",
      agentId: row.id,
      eventId: row.eventId,
      challengeId: row.challengeId,
      role: row.role,
    }
    const decision = verdict(db, c.req.method, c.req.path, principal)
    if (!decision.ok) {
      return jsonError(
        c,
        {
          code: "forbidden",
          message: `Agent ${principal.agentId} may not ${c.req.method} ${c.req.path}: ${decision.reason}`,
        },
        403
      )
    }
    setPrincipal(c, principal)
    await next()
  }
}

type PrincipalEnv = { Variables: { principal: Principal } }

function setPrincipal(c: Context, principal: Principal): void {
  // Hono's env typing does not flow through `app.use("*", ...)`; the
  // Variables contract lives in PrincipalEnv below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ;(c as unknown as Context<PrincipalEnv>).set("principal", principal)
}

/** The request's principal — every request has one (`{kind: "user"}` when no
 * token was presented). Routes only pass it on; scope decisions live in the
 * service layer. */
export function principalOf(c: Context): Principal {
  // Hono's env typing does not flow through `app.use("*", ...)`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const ctx = c as unknown as Context<{ Variables: { principal: Principal } }>
  return ctx.get("principal")
}
