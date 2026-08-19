import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { challenges, events } from "../db/schema"
import { principalOf } from "../infrastructure/agent-auth"
import { badRequest, jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import { WorkspaceFileError } from "../infrastructure/workspace-files"
import { EmptyInputSchema } from "../lib/schemas"
import { platformActionHttpError } from "../platforms/errors"
import { runActionError as runError } from "./errors"
import type { AgentService } from "./service"
import { streamAgent, streamChannel } from "./sse"

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
        const event = db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.id, eventId))
          .get()
        if (!event) return notFound(c, "Event not found")
        const challenge = db
          .select()
          .from(challenges)
          .where(eq(challenges.id, input.challengeId))
          .get()
        if (!challenge) return notFound(c, "Challenge not found")
        if (challenge.eventId !== eventId) {
          return badRequest(
            c,
            "invalid",
            "Challenge does not belong to this event"
          )
        }
        const queue = agentService.queue()
        const item = queue.enqueue({
          eventId,
          challengeId: challenge.id,
          prompt: input.prompt,
          model: input.model,
          promptMode: input.promptMode,
          timeoutMs: input.timeoutMs,
          source: principalOf(c) ? "scheduler" : "manual",
        })
        await queue.drainOnce()
        return c.json(
          queue.list(eventId).find((i) => i.id === item.id) ?? item,
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
        const agent = await agentService.spawn({
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
          source: principalOf(c) ? "scheduler" : "manual",
        })
        return c.json(agent, 201)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

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
    return c.json(agentService.fleet(eventId))
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
    const detail = agentService.getAgentDetail(c.req.param("agentId"))
    if (!detail) return notFound(c, "Agent not found")
    return c.json(detail)
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
    return c.json(agentService.listMessages(agentId, { after, sessionId }))
  })

  // Live event stream (EventSource). Ephemeral progress; reconnect re-reads
  // committed messages via GET .../messages.
  app.get("/api/agents/:agentId/stream", (c) =>
    streamAgent(c, agentService, c.req.param("agentId"))
  )

  app.post(
    "/api/agents/:agentId/message",
    validateJson(messageInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const agent = await agentService.sendMessage(c.req.param("agentId"), {
          text: body.text,
          deliverAs: body.deliverAs,
        })
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
          await agentService.switchAgentModel(c.req.param("agentId"), {
            model: body.model,
          })
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/agents/:agentId/stop", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await agentService.stopAgent(c.req.param("agentId")))
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
        return c.json(await agentService.closeAgent(c.req.param("agentId")))
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
            principalOf(c) ? "scheduler" : "user"
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
            c.req.valid("json").timeoutMs
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
        return c.json(await agentService.compactAgent(c.req.param("agentId")))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // Replace the agent's steer/followUp queue.
  app.put("/api/agents/:agentId/queue", validateJson(queueInput), async (c) => {
    try {
      const body = c.req.valid("json")
      await agentService.setQueue(c.req.param("agentId"), {
        steering: body.steering,
        followUp: body.followUp,
      })
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
        items: agentService.listAgentSessions(c.req.param("agentId")),
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
          await agentService.createAgentSession(c.req.param("agentId"))
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
            c.req.param("sessionId")
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
          await agentService.backtrackAgent(c.req.param("agentId"), body.seq)
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
        c.req.valid("json").flag
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
      return platformActionHttpError(c, error)
    }
  })

  app.delete("/api/agents/:agentId", async (c) => {
    try {
      await agentService.delete(c.req.param("agentId"))
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })

  // --- unified message layer (docs/im-channels.md §9.1) ---------------------

  /** Channel message SSE (IM view): initial latest-window snapshot, then live
   * `channel.message` pushes for the derived key. No agent identity — the UI
   * timeline view, not the SDK read path. ':' in the key is a legal path
   * character. */
  app.get("/api/channels/:channelKey/stream", (c) => {
    const channelKey = c.req.param("channelKey")
    if (!agentService.channels.parseChannelKey(channelKey)) {
      return badRequest(c, "invalid", `非法频道键：${channelKey}`)
    }
    return streamChannel(c, agentService, channelKey)
  })

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
      const principal = principalOf(c)
      if (principal && principal.id !== c.req.param("agentId")) {
        return badRequest(
          c,
          "invalid",
          "Agent channels are addressable only by the caller's own id"
        )
      }
      return c.json({
        items: agentService.channels.agentChannels(c.req.param("agentId")),
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
    const principal = principalOf(c)
    try {
      if (principal) {
        return c.json(
          agentService.channels.readForAgent(principal.id, channelKey, {
            after,
            limit,
            markRead,
          })
        )
      }
      return c.json(
        agentService.channels.listMessages(channelKey, {
          after,
          limit,
          before,
        })
      )
    } catch (error) {
      return runError(c, error)
    }
  })

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
        const message = await agentService.channels.postWithUpload({
          channelKey,
          author: { type: "user" },
          body: text,
          urgent,
          uploads: uploads.map((file) => ({
            filename: file.name,
            size: file.size,
            stream: () => file.arrayBuffer().then((b) => new Uint8Array(b)),
          })),
        })
        return c.json(message, 201)
      }
      // JSON path — requires an agent principal.
      const principal = principalOf(c)
      if (!principal) {
        return badRequest(
          c,
          "invalid",
          "JSON posts require an agent token (or use multipart)"
        )
      }
      const input = (await c.req.json()) as {
        text?: unknown
        tags?: unknown
        urgent?: unknown
        deliverAs?: unknown
        files?: unknown
      }
      if (typeof input.text !== "string" || !input.text.trim()) {
        return badRequest(c, "invalid", "text is required")
      }
      if (input.text.length > 16_000) {
        return badRequest(c, "invalid", "text exceeds the 16K character cap")
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
      const message = agentService.channels.post({
        channelKey,
        author: { type: "agent", agentId: principal.id },
        body: input.text,
        urgent: input.urgent === true,
        deliverAs,
        meta: tags.length ? { tags } : undefined,
        ...(files.length ? { files } : {}),
      })
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
