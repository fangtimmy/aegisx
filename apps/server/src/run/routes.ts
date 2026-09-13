import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { challenges, events } from "../db/schema"
import { principalOf } from "../infrastructure/agent-auth"
import {
  badRequest,
  jsonError,
  notFound,
  payloadTooLarge,
} from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import { WorkspaceFileError } from "../infrastructure/workspace-files"
import { responseJson } from "../lib/guards"
import { EmptyInputSchema } from "../lib/schemas"
import { platformActionHttpError } from "../platforms/errors"
import { RunActionError, runActionError as runError } from "./errors"
import type { AgentService } from "./service"
import { streamLive } from "./sse"

/** Enqueue a spawn item (POST /api/events/:eventId/queue): body carries the
 * challenge + spawn params. Models resolve at launch; the prompt shapes the
 * spawned agent's first turn. */
const enqueueInput = Type.Object(
  {
    challengeId: Type.String({ minLength: 1 }),
    /** The spawn prompt (strategy input; or the full first prompt with
     * promptMode="override"). */
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    promptMode: Type.Optional(
      Type.Union([Type.Literal("strategy"), Type.Literal("override")])
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    model: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false }
)

/** Direct spawn (POST /api/challenges/:challengeId/agents): bypasses the
 * queue; the fence cap rejects with 429 capacity. The SDK's
 * `agents.start` escape hatch. */
const spawnInput = Type.Object(
  {
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    promptMode: Type.Optional(
      Type.Union([Type.Literal("strategy"), Type.Literal("override")])
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    model: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false }
)

const timeoutInput = Type.Object(
  { timeoutMs: Type.Integer({ minimum: 60_000 }) },
  { additionalProperties: false }
)

const finishInput = Type.Object(
  { summary: Type.Optional(Type.String({ maxLength: 20_000 })) },
  { additionalProperties: false }
)

/** Model-switch body: a canonical model ref string
 * (`<providerKey>/<modelId>:<effort>`). */
const switchModelInput = Type.Object(
  { model: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false }
)

const flagInput = Type.Object(
  { flag: Type.String({ minLength: 1, maxLength: 10_000 }) },
  { additionalProperties: false }
)

const messageInput = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 20_000 }),
    deliverAs: Type.Optional(
      Type.Union([Type.Literal("steer"), Type.Literal("followUp")])
    ),
  },
  { additionalProperties: false }
)

const queueInput = Type.Object(
  {
    steering: Type.Array(Type.String({ maxLength: 20_000 })),
    followUp: Type.Array(Type.String({ maxLength: 20_000 })),
  },
  { additionalProperties: false }
)

const emptyInput = EmptyInputSchema

/** Scheduler plan (control-plane §B): the word list v1 — every variant
 * carries the scheduler's own short `ref`. Rationale is required; the action
 * list may be empty (the applier rejects it as an empty_plan outcome, not a
 * schema error). */
const planRef = Type.String({ minLength: 1, maxLength: 64 })
const planAction = Type.Union([
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("enqueue"),
      challengeId: Type.String({ minLength: 1 }),
      prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
      model: Type.Optional(Type.String({ maxLength: 300 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("message"),
      agentId: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1, maxLength: 20_000 }),
      urgent: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("stop"),
      agentId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("close"),
      agentId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("finish"),
      agentId: Type.String({ minLength: 1 }),
      summary: Type.String({ minLength: 1, maxLength: 20_000 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("setDeadline"),
      agentId: Type.String({ minLength: 1 }),
      timeoutMs: Type.Integer({ minimum: 60_000 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("cancelItem"),
      itemId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("reorder"),
      itemIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("setQueuePaused"),
      paused: Type.Boolean(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ref: planRef,
      kind: Type.Literal("noOp"),
      reason: Type.String({ minLength: 1, maxLength: 4_000 }),
    },
    { additionalProperties: false }
  ),
])

const planInput = Type.Object(
  {
    rationale: Type.String({ minLength: 1, maxLength: 4_000 }),
    actions: Type.Array(planAction, { maxItems: 50 }),
  },
  { additionalProperties: false }
)

/** Flat-backtrack body: the session_entries.seq to KEEP (delete everything
 * after it in the agent's active session). */
const backtrackInput = Type.Object(
  { seq: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
)

export function registerRunRoutes(
  app: Hono,
  options: {
    db: Database
    agentService: AgentService
  }
) {
  const { db, agentService } = options

  // --- spawn: direct + queued ---------------------------------------------

  /** Enqueue a spawn item, then run one drain pass so a launchable item
   * starts synchronously; the item stays pending if the fence is full. */
  app.post(
    "/api/events/:eventId/queue",
    validateJson(enqueueInput),
    async (c) => {
      try {
        const input = c.req.valid("json")
        const eventId = c.req.param("eventId")
        if (
          !db
            .select({ id: events.id })
            .from(events)
            .where(eq(events.id, eventId))
            .get()
        ) {
          return notFound(c, "Event not found")
        }
        if (
          !db
            .select({ id: challenges.id })
            .from(challenges)
            .where(eq(challenges.id, input.challengeId))
            .get()
        ) {
          return notFound(c, "Challenge not found")
        }
        agentService.assertModelsResolvable(input.model)
        const queue = agentService.queue()
        const item = queue.enqueue(
          {
            eventId,
            challengeId: input.challengeId,
            prompt: input.prompt,
            model: input.model,
            promptMode: input.promptMode,
            timeoutMs: input.timeoutMs,
            source: principalOf(c).kind === "agent" ? "scheduler" : "manual",
          },
          principalOf(c)
        )
        await queue.drainOnce()
        return c.json(
          queue.list(eventId, principalOf(c)).find((i) => i.id === item.id) ??
            item,
          202
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Direct spawn: one agent on the challenge (bypasses the queue; a full
   * fence rejects with capacity). */
  app.post(
    "/api/challenges/:challengeId/agents",
    validateJson(spawnInput),
    async (c) => {
      try {
        const input = c.req.valid("json")
        const challengeId = c.req.param("challengeId")
        const challenge = db
          .select()
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .get()
        if (!challenge) return notFound(c, "Challenge not found")
        const agent = await agentService.spawn(
          {
            eventId: challenge.eventId,
            challengeId,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
            ...(input.promptMode !== undefined
              ? { promptMode: input.promptMode }
              : {}),
            ...(input.timeoutMs !== undefined
              ? { timeoutMs: input.timeoutMs }
              : {}),
            source: principalOf(c).kind === "agent" ? "scheduler" : "manual",
          },
          principalOf(c)
        )
        return c.json(agent, 201)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Force-halt a challenge: close its live agents + cancel its pending
   * queue items + best-effort stop the platform target. */
  app.post(
    "/api/challenges/:challengeId/halt",
    validateJson(emptyInput),
    async (c) => {
      try {
        const challengeId = c.req.param("challengeId")
        const challenge = db
          .select({ id: challenges.id })
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .get()
        if (!challenge) return notFound(c, "Challenge not found")
        return c.json(await agentService.haltChallenge(challengeId))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Event-level emergency halt: freeze the queue + pause the scheduler +
   * hold the inbox + close all live solvers + stop all targets. Reversible
   * via /resume. */
  app.post("/api/events/:eventId/halt", validateJson(emptyInput), async (c) => {
    try {
      return c.json(
        await agentService.haltEvent(c.req.param("eventId"), principalOf(c))
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Release an event halt: inbox backlog flushes, scheduler re-syncs, the
   * queue drains again. */
  app.post(
    "/api/events/:eventId/resume",
    validateJson(emptyInput),
    async (c) => {
      try {
        await agentService.resumeEvent(c.req.param("eventId"), principalOf(c))
        return c.json({ state: "running" })
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Close every live solver agent of the event (aborted, reopenable) —
   * queue and scheduler untouched. */
  app.post(
    "/api/events/:eventId/agents/close",
    validateJson(emptyInput),
    async (c) => {
      try {
        const closed = await agentService.closeEventAgents(
          c.req.param("eventId"),
          principalOf(c)
        )
        return c.json({ closed })
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Submit the scheduler's typed plan. The agent-auth verdict admits only
   * this event's scheduler; the applier re-asserts the event scope. Per-ref
   * validation failures are 200 plan outcomes (same-turn repair); only a
   * malformed envelope/schema is a 400. */
  app.post("/api/events/:eventId/plan", validateJson(planInput), async (c) => {
    const eventId = c.req.param("eventId")
    if (
      !db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, eventId))
        .get()
    ) {
      return notFound(c, "Event not found")
    }
    try {
      return c.json(
        await agentService.submitPlan(
          eventId,
          c.req.valid("json"),
          principalOf(c)
        )
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  // --- fleet ----------------------------------------------------------------

  /** The event overview's single poll: challenges + per-challenge agents +
   * the scheduler agent + scheduler config/status. */
  app.get("/api/events/:eventId/fleet", (c) => {
    const eventId = c.req.param("eventId")
    const event = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .get()
    if (!event) return notFound(c, "Event not found")
    try {
      return c.json(agentService.fleet(eventId, principalOf(c)))
    } catch (error) {
      return runError(c, error)
    }
  })

  // --- challenge workspace files --------------------------------------------

  app.get("/api/challenges/:challengeId/files", (c) => {
    const challengeId = c.req.param("challengeId")
    const challenge = db
      .select({ eventId: challenges.eventId })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) return notFound(c, "Challenge not found")
    try {
      return c.json(
        agentService.workspaceFiles(
          challenge.eventId,
          challengeId,
          c.req.query("path") ?? ""
        )
      )
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/challenges/:challengeId/files/download", (c) => {
    const challengeId = c.req.param("challengeId")
    const challenge = db
      .select({ eventId: challenges.eventId })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) return notFound(c, "Challenge not found")
    try {
      const file = agentService.workspaceDownloadPath(
        challenge.eventId,
        challengeId,
        c.req.query("path") ?? ""
      )
      // Bun's File.stream() type differs from the DOM ReadableStream alias.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return new Response(file.stream as unknown as ReadableStream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        },
      })
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  // --- agent detail / stream / actions --------------------------------------

  app.get("/api/agents/:agentId", (c) => {
    try {
      const detail = agentService.getAgentDetail(
        c.req.param("agentId"),
        principalOf(c)
      )
      if (!detail) return notFound(c, "Agent not found")
      return c.json(detail)
    } catch (error) {
      return runError(c, error)
    }
  })

  /** The agent's durable committed entries, paginated by per-session seq
   * (`after` → `nextAfter`; echo nextAfter back as after; 0 = full pull).
   * `sessionId` selects a non-active session (multi-session v12). */
  app.get("/api/agents/:agentId/messages", (c) => {
    const agentId = c.req.param("agentId")
    if (!agentService.getAgent(agentId)) return notFound(c, "Agent not found")
    const afterRaw = Number.parseInt(c.req.query("after") ?? "0", 10)
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    const sessionId = c.req.query("sessionId") || undefined
    try {
      return c.json(
        agentService.listMessages(agentId, { after, sessionId }, principalOf(c))
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  // The single multiplexed live event stream (EventSource): every agent's
  // events plus every channel message over ONE connection, dispatched client
  // side by the identity in the payload. Ephemeral; reconnect re-reads
  // committed messages via GET .../messages. No agent id in the path, so
  // there is no per-agent 404 to special-case.
  app.get("/api/stream", (c) => {
    try {
      return streamLive(c, agentService, principalOf(c))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post(
    "/api/agents/:agentId/message",
    validateJson(messageInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const agent = await agentService.sendMessage(
          c.req.param("agentId"),
          {
            text: body.text,
            deliverAs: body.deliverAs,
          },
          principalOf(c)
        )
        return c.json(agent)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/agents/:agentId/model",
    validateJson(switchModelInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(
          await agentService.switchAgentModel(
            c.req.param("agentId"),
            { model: body.model },
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/agents/:agentId/stop", validateJson(emptyInput), async (c) => {
    try {
      return c.json(
        await agentService.stopAgent(c.req.param("agentId"), principalOf(c))
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Terminal close (user/scheduler): aborted; files + DB session survive
   * (a message reopens on demand). */
  app.post(
    "/api/agents/:agentId/close",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(
          await agentService.closeAgent(c.req.param("agentId"), principalOf(c))
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  /** Force-finish: completed + summary (the sanctioned terminal transition
   * for a live agent; idempotent on an already-completed one). */
  app.post(
    "/api/agents/:agentId/finish",
    validateJson(finishInput),
    async (c) => {
      try {
        const summary = c.req.valid("json").summary?.trim() ?? ""
        return c.json(
          await agentService.finishAgent(
            c.req.param("agentId"),
            summary,
            principalOf(c).kind === "agent" ? "scheduler" : "user",
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/agents/:agentId/timeout",
    validateJson(timeoutInput),
    async (c) => {
      try {
        return c.json(
          agentService.setAgentTimeout(
            c.req.param("agentId"),
            c.req.valid("json").timeoutMs,
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/agents/:agentId/compact",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(
          await agentService.compactAgent(
            c.req.param("agentId"),
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // Replace the agent's steer/followUp queue.
  app.put("/api/agents/:agentId/queue", validateJson(queueInput), async (c) => {
    try {
      const body = c.req.valid("json")
      await agentService.setQueue(
        c.req.param("agentId"),
        {
          steering: body.steering,
          followUp: body.followUp,
        },
        principalOf(c)
      )
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })

  // Multi-session (v12): list / create / activate an agent's sessions, and
  // flat backtrack (delete everything after a seq in the active session).
  app.get("/api/agents/:agentId/sessions", (c) => {
    try {
      return c.json({
        items: agentService.listAgentSessions(
          c.req.param("agentId"),
          principalOf(c)
        ),
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post(
    "/api/agents/:agentId/sessions",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(
          await agentService.createAgentSession(
            c.req.param("agentId"),
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/agents/:agentId/sessions/:sessionId/activate",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(
          await agentService.activateAgentSession(
            c.req.param("agentId"),
            c.req.param("sessionId"),
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/agents/:agentId/backtrack",
    validateJson(backtrackInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(
          await agentService.backtrackAgent(
            c.req.param("agentId"),
            body.seq,
            principalOf(c)
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/agents/:agentId/flag", validateJson(flagInput), async (c) => {
    const agentId = c.req.param("agentId")
    const agent = agentService.getAgent(agentId)
    if (!agent) return notFound(c, "Agent not found")
    if (!agent.challengeId)
      return badRequest(c, "invalid", "Agent has no challenge")
    try {
      const result = await agentService.submitFlag(
        agent.challengeId,
        agentId,
        c.req.valid("json").flag,
        principalOf(c)
      )
      agentService.refresh(agentId)
      if (!result) {
        return badRequest(
          c,
          "not_bound",
          "Challenge is not managed by a platform"
        )
      }
      return c.json({ result })
    } catch (error) {
      if (error instanceof RunActionError) return runError(c, error)
      return platformActionHttpError(c, error)
    }
  })

  app.delete("/api/agents/:agentId", async (c) => {
    try {
      await agentService.delete(c.req.param("agentId"), principalOf(c))
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })

  // --- unified message layer ---------------------

  /** The challenge's channel tree: #team + one DM per agent of the
   * challenge (derived keys — the tree exists as long as the agent rows
   * do; no announce needed). */
  app.get("/api/challenges/:challengeId/channels", (c) => {
    try {
      return c.json({
        items: agentService.channels.challengeChannelTree(
          c.req.param("challengeId")
        ),
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  /** SDK channels.list: the agent's visible channels + unread counts. With
   * an agent principal the path id must be the caller's own. */
  app.get("/api/agents/:agentId/channels", (c) => {
    try {
      return c.json({
        items: agentService.channels.agentChannels(
          c.req.param("agentId"),
          principalOf(c)
        ),
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Channel timeline (paginated by the global message-id cursor). With an
   * agent principal this is the SDK read path: visibility-enforced and
   * pull-is-read (the cursor advances unless markRead=0). `channelKey` is a
   * derived key (`team:<cid>` / `dm:<aid>` / `orch:<eid>`) — ':' is a legal
   * path character. */
  app.get("/api/channels/:channelKey/messages", (c) => {
    const channelKey = c.req.param("channelKey")
    const afterRaw = Number.parseInt(c.req.query("after") ?? "0", 10)
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    const beforeRaw = Number.parseInt(c.req.query("before") ?? "", 10)
    const before =
      Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10)
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50
    const markRead = c.req.query("markRead") !== "0"
    try {
      return c.json(
        agentService.channels.read(
          channelKey,
          { after, limit, before, markRead },
          principalOf(c)
        )
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Download a recorded message attachment: resolves the message + path
   * back to the challenge workspace's shared/ tree it landed in (no
   * free-form workspace reads). */
  app.get("/api/channels/:channelKey/files/download", (c) => {
    const messageId = Number.parseInt(c.req.query("message") ?? "", 10)
    const path = c.req.query("path") ?? ""
    if (!Number.isFinite(messageId) || messageId <= 0 || !path) {
      return badRequest(c, "invalid", "message and path are required")
    }
    try {
      const target = agentService.channels.channelFileTarget(
        c.req.param("channelKey"),
        messageId,
        path
      )
      const file = agentService.workspaceDownloadPath(
        target.eventId,
        target.challengeId,
        path
      )
      // Bun's File.stream() type differs from the DOM ReadableStream alias.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return new Response(file.stream as unknown as ReadableStream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(target.filename)}`,
        },
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Mirrors MAX_MESSAGE_TOTAL_BYTES in channels-post: the per-message
   * attachment ceiling its per-file checks enforce. A body declared beyond
   * it can never pass, so reject before formData() buffers it all. */
  const MAX_UPLOAD_BODY_BYTES = 128 * 1024 * 1024
  /** Post a channel message. Two faces on one route:
   *  - JSON + agent principal (bearer token) → the SDK path (files = paths
   *    relative to the agent's own directory, server-side resolve check +
   *    copy into the challenge workspace's shared/; `urgent` explicit, SDK
   *    defaults false).
   *  - multipart/form-data (text + files[] + urgent) → the UI user post
   *    (file blobs land in shared/upload-<ts>/; urgent defaults TRUE — a
   *    user IM post is intended). */
  app.post("/api/channels/:channelKey/messages", async (c) => {
    const channelKey = c.req.param("channelKey")
    const contentType = c.req.header("content-type")?.split(";", 1)[0]
    try {
      if (contentType === "multipart/form-data") {
        // Early face gate (before formData buffers the body): multipart is
        // the USER serializer. The same rule is enforced again — identity
        // and all — inside channels.postWithUpload's resolveAuthor.
        if (principalOf(c).kind === "agent") {
          return badRequest(
            c,
            "invalid",
            "multipart posts are the user face; agents post JSON (files = workspace paths)"
          )
        }
        const declared = Number.parseInt(
          c.req.header("content-length") ?? "",
          10
        )
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BODY_BYTES) {
          return payloadTooLarge(
            c,
            "payload_too_large",
            "Multipart body exceeds the 128MB attachment cap"
          )
        }
        const form = await c.req.formData()
        const textEntry = form.get("text")
        const text = (typeof textEntry === "string" ? textEntry : "").trim()
        if (!text) return badRequest(c, "invalid", "text is required")
        const urgentEntry = form.get("urgent")
        const urgent =
          (typeof urgentEntry === "string" ? urgentEntry : "") !== "false"
        const uploads = [...form.getAll("files")].filter(
          (entry): entry is File => entry instanceof File
        )
        const message = await agentService.channels.postWithUpload(
          {
            channelKey,
            author: { type: "user" },
            body: text,
            urgent,
            uploads: uploads.map((file) => ({
              filename: file.name,
              size: file.size,
              stream: () => file.arrayBuffer().then((b) => new Uint8Array(b)),
            })),
          },
          principalOf(c)
        )
        return c.json(message, 201)
      }
      // JSON path — requires an agent principal.
      const principal = principalOf(c)
      if (principal.kind !== "agent") {
        return badRequest(
          c,
          "invalid",
          "JSON posts require an agent token (or use multipart)"
        )
      }
      const input = await responseJson<{
        text?: unknown
        tags?: unknown
        urgent?: unknown
        deliverAs?: unknown
        files?: unknown
      }>(c.req)
      if (typeof input.text !== "string" || !input.text.trim()) {
        return badRequest(c, "invalid", "text is required")
      }
      if (input.text.length > 20_000) {
        return badRequest(c, "invalid", "text exceeds the 20K character cap")
      }
      const tags = Array.isArray(input.tags)
        ? input.tags
            .filter((t): t is string => typeof t === "string")
            .slice(0, 8)
        : []
      const files = Array.isArray(input.files)
        ? input.files
            .filter((f): f is string => typeof f === "string")
            .slice(0, 8)
        : []
      const deliverAs = input.deliverAs === "followUp" ? "followUp" : "steer"
      const message = agentService.channels.post(
        {
          channelKey,
          author: { type: "agent", agentId: principal.agentId },
          body: input.text,
          urgent: input.urgent === true,
          deliverAs,
          meta: tags.length ? { tags } : undefined,
          ...(files.length ? { files } : {}),
        },
        principal
      )
      return c.json(message, 201)
    } catch (error) {
      return runError(c, error)
    }
  })
}

function workspaceFileError(
  c: Parameters<typeof jsonError>[0],
  error: unknown
) {
  if (!(error instanceof WorkspaceFileError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found" ? 404 : 400
  )
}
