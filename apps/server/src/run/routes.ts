import type { AgentSummary } from "@aegisx/shared/agent"
import { eq, inArray } from "drizzle-orm"
import type { Context, Hono } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { agents, challenges, events } from "../db/schema"
import { badRequest, jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { EmptyInputSchema } from "../lib/schemas"
import { platformActionHttpError } from "../platforms/errors"
import { runActionError as runError } from "./errors"
import { toAgentSummary } from "./public"
import type { RunService } from "./service"
import { streamRun } from "./sse"

/** Agent identity header for SDK channel calls (docs/im-channels.md §四):
 * the per-exec env AEGISX_AGENT_ID rides this header; the server resolves the
 * posting/reading agent from it. No token — the accepted curl boundary from
 * scheduler-python-sdk.md §四 applies. */
const AGENT_ID_HEADER = "x-aegisx-agent-id"

/** Manual enqueue body (POST /api/challenges/:id/runs enqueues, returns a
 * queue item). Models resolve at launch; the run-level strategy shapes every
 * solver's first turn. */
const runInput = Type.Object(
  {
    /** Legacy alias of `strategy` (pre-v9 clients). */
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    /** v9 run-level strategy — appended to every solver's initial prompt as a
     * Strategy section (the standard blocks are always included). */
    strategy: Type.Optional(Type.String({ maxLength: 20_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    /** v9 model ref applied to every solver. */
    model: Type.Optional(Type.String({ maxLength: 300 })),
    /** v9 solver count (1..4, default 1). */
    solver_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    /** v9 per-solver specs (advanced); takes precedence over
     * model/solver_count. */
    solvers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            model: Type.Optional(Type.String({ maxLength: 300 })),
            prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
            promptMode: Type.Optional(
              Type.Union([Type.Literal("strategy"), Type.Literal("override")])
            ),
          },
          { additionalProperties: false }
        ),
        { maxItems: 4 }
      )
    ),
    /** Who is enqueueing — the Python SDK sends "scheduler" (its default;
     * the SDK is the scheduler's face), the web UI omits it (→ manual). */
    source: Type.Optional(
      Type.Union([Type.Literal("manual"), Type.Literal("scheduler")])
    ),
  },
  { additionalProperties: false }
)

/** Direct-start body (POST /api/runs/start): runInput + a challengeId. The
 * scheduler SDK's `runs.start` escape hatch — bypasses the queue exactly like
 * the scheduler tool's start_run (source=scheduler). */
const startRunInput = Type.Object(
  {
    challengeId: Type.String({ minLength: 1 }),
    strategy: Type.Optional(Type.String({ maxLength: 20_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    model: Type.Optional(Type.String({ maxLength: 300 })),
    solver_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    /** Who is starting (web UI sends "manual"; the SDK omits it). */
    source: Type.Optional(
      Type.Union([Type.Literal("manual"), Type.Literal("scheduler")])
    ),
    solvers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            model: Type.Optional(Type.String({ maxLength: 300 })),
            prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
            promptMode: Type.Optional(
              Type.Union([Type.Literal("strategy"), Type.Literal("override")])
            ),
          },
          { additionalProperties: false }
        ),
        { maxItems: 4 }
      )
    ),
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
 * (`<providerKey>/<modelId>:<effort>` or `alias:<id>`). */
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

/** Add-agent body (POST /api/runs/:runId/agents): dynamically
 * expand a run with one more solver. `prompt` is required — expansion always
 * comes with a job. */
const addAgentInput = Type.Object(
  {
    model: Type.Optional(Type.String({ maxLength: 300 })),
    prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
    promptMode: Type.Optional(
      Type.Union([Type.Literal("strategy"), Type.Literal("override")])
    ),
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
    dataDir: string
    runService: RunService
  }
) {
  const { db, runService } = options

  app.post(
    "/api/challenges/:challengeId/runs",
    validateJson(runInput),
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

        // Enqueue, then run one drain pass so a launchable task is
        // started synchronously; the item stays pending if the fence is full.
        // Fail fast on an unresolvable model ref — otherwise it
        // would surface only at (auto-)launch, as a failed queue item.
        runService.assertModelsResolvable(input.model, input.solvers)
        const queue = runService.queue()
        const item = queue.enqueue({
          eventId: challenge.eventId,
          challengeId,
          strategy: input.strategy ?? input.prompt,
          model: input.model,
          solverCount: input.solver_count,
          solvers: input.solvers,
          timeoutMs: input.timeoutMs,
          source: input.source ?? "manual",
        })
        await queue.drainOnce()
        return c.json(
          queue.list(challenge.eventId).find((i) => i.id === item.id) ?? item,
          202
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/runs/start", validateJson(startRunInput), async (c) => {
    try {
      const input = c.req.valid("json")
      const challenge = db
        .select()
        .from(challenges)
        .where(eq(challenges.id, input.challengeId))
        .get()
      if (!challenge) return notFound(c, "Challenge not found")
      // Fail fast on an unresolvable model ref (same as the enqueue path).
      runService.assertModelsResolvable(input.model, input.solvers)
      const run = await runService.resolveAndCreate({
        challengeId: input.challengeId,
        strategy: input.strategy,
        model: input.model,
        solverCount: input.solver_count,
        solvers: input.solvers,
        timeoutMs: input.timeoutMs,
        source: input.source ?? "scheduler",
      })
      return c.json(run, 201)
    } catch (error) {
      return runError(c, error)
    }
  })

  // --- unified message layer (docs/im-simplify-v18.md §9.1) -------------------

  /** A run's channel tree: #team + one DM per solver (derived keys; the
   * tree exists as long as the run's agent rows do — no announce). */
  app.get("/api/runs/:runId/channels", (c) => {
    const runId = c.req.param("runId")
    if (!runService.get(runId)) return notFound(c, "Run not found")
    return c.json({ items: runService.channels.runChannelTree(runId) })
  })

  /** The challenge's #team (exactly one) — the challenge-level IM view
   * (v17 knowledge base; works with no run on the challenge). */
  app.get("/api/challenges/:challengeId/channels", (c) => {
    try {
      return c.json({
        items: runService.channels.challengeChannelTree(
          c.req.param("challengeId")
        ),
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  /** SDK channels.list: the agent's visible channels + unread counts. */
  app.get("/api/agents/:agentId/channels", (c) => {
    try {
      return c.json({
        items: runService.channels.agentChannels(c.req.param("agentId")),
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Channel timeline (paginated by the global message-id cursor). With the
   * agent identity header this is the SDK read path: visibility-enforced and
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
    const agentId = c.req.header(AGENT_ID_HEADER) ?? ""
    try {
      if (agentId) {
        return c.json(
          runService.channels.readForAgent(agentId, channelKey, {
            after,
            limit,
            markRead,
          })
        )
      }
      return c.json(
        runService.channels.listMessages(channelKey, {
          after,
          limit,
          before,
        })
      )
    } catch (error) {
      return runError(c, error)
    }
  })

  /** Post a channel message. Two faces on one route (§9.1):
   *  - JSON + agent identity header → the SDK path (files = workspace paths,
   *    server-side resolve check + snapshot copy; `urgent` explicit, SDK
   *    defaults false per §3.2).
   *  - multipart/form-data (text + files[] + urgent) → the UI user post
   *    (file blobs; urgent defaults TRUE — a user IM post is intended). */
  app.post("/api/channels/:channelKey/messages", async (c) => {
    const channelKey = c.req.param("channelKey")
    const contentType = c.req.header("content-type")?.split(";", 1)[0]
    try {
      if (contentType === "multipart/form-data") {
        const form = await c.req.formData()
        const text = String(form.get("text") ?? "").trim()
        if (!text) return badRequest(c, "invalid", "text is required")
        const urgent = String(form.get("urgent") ?? "") !== "false"
        const uploads = [...form.getAll("files")].filter(
          (entry): entry is File => entry instanceof File
        )
        const message = await runService.channels.postWithUpload({
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
      // JSON path — requires the agent identity header.
      const agentId = c.req.header(AGENT_ID_HEADER) ?? ""
      if (!agentId) {
        return badRequest(
          c,
          "invalid",
          "JSON posts require the agent identity header (or use multipart)"
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
      const message = runService.channels.post({
        channelKey,
        author: { type: "agent", agentId },
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

  /** Attachment download / preview (users + SDK fetch materialization).
   * `?meta=1` returns the JSON metadata instead of the bytes (fetch uses the
   * original filename for its default dest). */
  app.get("/api/channel-files/:fileId", (c) => {
    try {
      const { row, path } = runService.channels.fileById(c.req.param("fileId"))
      if (c.req.query("meta") === "1") {
        return c.json({
          id: row.id,
          filename: row.filename,
          size: row.size,
          createdAt: row.createdAt,
        })
      }
      return new Response(Bun.file(path), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        },
      })
    } catch (error) {
      return runError(c, error)
    }
  })

  app.get("/api/runs/:runId", (c) => {
    const detail = runService.detail(c.req.param("runId"))
    if (!detail) return notFound(c, "Run not found")
    return c.json(detail)
  })

  /** W7.3 fleet endpoint: everything the event overview polls in ONE request
   * (was listEventRuns + N× getRun + GET /scheduler). Runs are the light
   * `listForEvent` shape (no per-run usage — the fleet view doesn't need it;
   * the detail path keeps it). Agents come from one `runId IN (...)` query;
   * the scheduler run + its agents are included so the fleet query fully
   * replaces the old fleet + scheduler pair. */
  app.get("/api/events/:eventId/fleet", (c) => {
    const eventId = c.req.param("eventId")
    const event = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .get()
    if (!event) return notFound(c, "Event not found")
    const runs = runService.listForEvent(eventId)
    const agentsByRun: Record<string, AgentSummary[]> = {}
    const runIds = runs.map((run) => run.id)
    if (runIds.length > 0) {
      for (const row of db
        .select()
        .from(agents)
        .where(inArray(agents.runId, runIds))
        .all()) {
        const list = agentsByRun[row.runId] ?? []
        list.push(toAgentSummary(row))
        agentsByRun[row.runId] = list
      }
    }
    const schedulerRun = runService.getSchedulerRun(eventId) ?? null
    return c.json({
      runs,
      agentsByRun,
      schedulerRun,
      schedulerAgents: schedulerRun
        ? runService.listAgents(schedulerRun.id)
        : [],
      // The merged scheduler query also carried config + status.
      config: runService.getSchedulerConfig(eventId),
      status: runService.getStatus(eventId),
    })
  })

  app.get("/api/runs/:runId/files", (c) => {
    const root = runService.runDirPath(c.req.param("runId"))
    if (!root) return notFound(c, "Run not found")
    try {
      return c.json(readWorkspacePath(root, c.req.query("path") ?? ""))
    } catch (error) {
      return workspaceFileError(c, error)
    }
  })

  app.get("/api/runs/:runId/files/download", (c) => {
    const root = runService.runDirPath(c.req.param("runId"))
    if (!root) return notFound(c, "Run not found")
    try {
      const file = workspaceDownload(root, c.req.query("path") ?? "")
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

  // Run-level message list with an opaque pagination cursor (`after` →
  // `nextAfter`). Two cursor semantics: run-level (no agentId) uses SQLite
  // rowid (insertion order across all agents' active sessions — per-session
  // seqs interleave and would silently drop later entries); per-agent (with
  // agentId) uses the per-session seq (also the backtrack API's target key).
  // Clients echo nextAfter back as after; after=0 is a full pull.
  app.get("/api/runs/:runId/messages", (c) => {
    const runId = c.req.param("runId")
    if (!runService.get(runId)) return notFound(c, "Run not found")
    const afterRaw = Number.parseInt(c.req.query("after") ?? "0", 10)
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    const agentId = c.req.query("agentId") || undefined
    const sessionId = c.req.query("sessionId") || undefined
    return c.json(runService.listMessages(runId, { after, agentId, sessionId }))
  })

  // Live event stream (EventSource). Ephemeral progress; reconnect re-reads
  // committed messages via GET .../messages.
  app.get("/api/runs/:runId/stream", (c) =>
    streamRun(c, runService, c.req.param("runId"))
  )

  app.post(
    "/api/runs/:runId/message",
    validateJson(messageInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await runService.sendMessage(c.req.param("runId"), {
          text: body.text,
          deliverAs: body.deliverAs,
        })
        return c.json(run)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // Dynamically add one more solver to a run: running/idle runs
  // gain it in place; a closed run is cold-restored first (the old solvers
  // stay dormant until messaged).
  app.post(
    "/api/runs/:runId/agents",
    validateJson(addAgentInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await runService.addAgent(c.req.param("runId"), {
          prompt: body.prompt,
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.promptMode !== undefined
            ? { promptMode: body.promptMode }
            : {}),
        })
        return c.json(run)
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // Per-agent actions: message / model / stop address one agent
  // (messageing a closed run's agent cold-restores it, same as the run-level
  // path but targeting the named agent).
  app.post(
    "/api/agents/:agentId/message",
    validateJson(messageInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await runService.sendAgentMessage(c.req.param("agentId"), {
          text: body.text,
          deliverAs: body.deliverAs,
        })
        return c.json(run)
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
          await runService.switchAgentModel(c.req.param("agentId"), {
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
      return c.json(await runService.stopAgent(c.req.param("agentId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post(
    "/api/agents/:agentId/compact",
    validateJson(emptyInput),
    async (c) => {
      try {
        return c.json(await runService.compactAgent(c.req.param("agentId")))
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  // Multi-session (v12): list / create / activate an agent's sessions, and
  // flat backtrack (delete everything after a seq in the active session).
  app.get("/api/agents/:agentId/sessions", (c) => {
    try {
      return c.json({
        items: runService.listAgentSessions(c.req.param("agentId")),
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
          await runService.createAgentSession(c.req.param("agentId"))
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
          await runService.activateAgentSession(
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
          await runService.backtrackAgent(c.req.param("agentId"), body.seq)
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.put("/api/runs/:runId/queue", validateJson(queueInput), async (c) => {
    try {
      const body = c.req.valid("json")
      await runService.setQueue(c.req.param("runId"), {
        steering: body.steering,
        followUp: body.followUp,
      })
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/stop", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runService.stop(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post(
    "/api/runs/:runId/timeout",
    validateJson(timeoutInput),
    async (c) => {
      try {
        return c.json(
          runService.setRunTimeout(
            c.req.param("runId"),
            c.req.valid("json").timeoutMs
          )
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post(
    "/api/runs/:runId/switch-model",
    validateJson(switchModelInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(
          await runService.switchModel(c.req.param("runId"), {
            model: body.model,
          })
        )
      } catch (error) {
        return runError(c, error)
      }
    }
  )

  app.post("/api/runs/:runId/close", validateJson(emptyInput), async (c) => {
    try {
      return c.json(await runService.closeRun(c.req.param("runId")))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/finish", validateJson(finishInput), async (c) => {
    try {
      const summary = c.req.valid("json").summary?.trim() ?? ""
      return c.json(await runService.finish(c.req.param("runId"), summary))
    } catch (error) {
      return runError(c, error)
    }
  })

  app.post("/api/runs/:runId/flag", validateJson(flagInput), async (c) => {
    const runId = c.req.param("runId")
    const run = runService.get(runId)
    if (!run) return notFound(c, "Run not found")
    if (!run.challengeId) return notFound(c, "Run has no challenge")
    try {
      const result = await runService.submitFlag(
        runId,
        run.challengeId,
        c.req.valid("json").flag
      )
      runService.refresh(runId)
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

  app.get("/api/runs/:runId/target", async (c) => {
    const run = runService.get(c.req.param("runId"))
    if (!run) return notFound(c, "Run not found")
    if (!run.challengeId) return notFound(c, "Run has no challenge")
    try {
      return c.json(await runService.targetAction(run.challengeId, "get"))
    } catch (error) {
      return platformActionHttpError(c, error)
    }
  })

  for (const action of ["start", "extend", "stop"] as const) {
    app.post(
      `/api/runs/:runId/target/${action}`,
      validateJson(emptyInput),
      async (c) => {
        const run = runService.get(c.req.param("runId"))
        if (!run) return notFound(c, "Run not found")
        if (!run.challengeId) return notFound(c, "Run has no challenge")
        try {
          return c.json(await runService.targetAction(run.challengeId, action))
        } catch (error) {
          return platformActionHttpError(c, error)
        }
      }
    )
  }

  app.delete("/api/runs/:runId", async (c) => {
    try {
      await runService.delete(c.req.param("runId"))
      return c.body(null, 204)
    } catch (error) {
      return runError(c, error)
    }
  })
}

function workspaceFileError(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceFileError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found" ? 404 : 400
  )
}
