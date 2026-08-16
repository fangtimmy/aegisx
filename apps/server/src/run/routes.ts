import { resolveModelRef } from "@aegisx/shared"
import type { AgentSummary } from "@aegisx/shared/agent"
import { eq, inArray } from "drizzle-orm"
import type { Context, Hono } from "hono"
import { Type } from "typebox"

import type { Database } from "../db"
import { agents, challenges, events } from "../db/schema"
import type { ConfigStore } from "../infrastructure/config-store"
import { badRequest, jsonError, notFound } from "../infrastructure/http-errors"
import { validateJson } from "../infrastructure/validation"
import {
  readWorkspacePath,
  WorkspaceFileError,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import { EmptyInputSchema } from "../lib/schemas"
import { listPlugins, requirePlugin } from "../orchestration/registry"
import { toOrchestrationPublic } from "../orchestration/types"
import { platformActionHttpError } from "../platforms/errors"
import { getProviderConnections } from "../providers/public"
import { RunActionError } from "./errors"
import { toAgentSummary } from "./public"
import type { RunService } from "./service"
import { streamRun } from "./sse"

/** Manual enqueue body (POST /api/challenges/:id/runs enqueues,
 * returns a queue item). Models resolve at launch; the first-turn prompt may
 * be overridden. */
const runInput = Type.Object(
  {
    /** Per-run strategy — appended to the run's default initial prompt as a
     * Strategy section (the standard blocks are always included). */
    prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
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
    configStore: ConfigStore
  }
) {
  const { db, runService, configStore } = options

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
        const queue = runService.queue()
        const item = queue.enqueue({
          eventId: challenge.eventId,
          challengeId,
          prompt: input.prompt,
          timeoutMs: input.timeoutMs,
          source: "manual",
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

  /** Orchestration plugin registry (id, scope, agents, templates) — the
   * orchestration-settings page + create-run picker render against it. */
  app.get("/api/orchestrations", (c) =>
    c.json({ items: listPlugins().map(toOrchestrationPublic) })
  )

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

  // --- orchestration settings (per-plugin, per-slot model refs) -------------

  /** Validate that a model ref resolves to an enabled provider+model (or a
   * configured alias). Throws with a user-facing message otherwise. */
  function requireResolvableRef(ref: string): void {
    const target = resolveModelRef(
      ref,
      getProviderConnections(configStore),
      configStore.getAliases()
    )
    if (!target) {
      throw new RunActionError("invalid_state", `Unknown model "${ref}"`)
    }
  }

  /** GET /api/orchestration-config — every plugin with its declared slots and
   * the currently-configured model ref per slot (null = global default). */
  app.get("/api/orchestration-config", (c) => {
    const configured = configStore.getAgentModels()
    return c.json({
      items: listPlugins().map((plugin) => ({
        ...toOrchestrationPublic(plugin),
        agents: plugin.agents.map((agent) => ({
          slot: agent.slot,
          role: agent.role ?? agent.slot,
          name: agent.name,
          entry: !!agent.entry,
          model: configured[plugin.id]?.[agent.slot] ?? null,
        })),
      })),
    })
  })

  const slotModelPatchInput = Type.Object(
    {
      /** slot → model ref. A null value clears the slot (fall back to the
       * global default). */
      slots: Type.Record(
        Type.String(),
        Type.Union([Type.String(), Type.Null()])
      ),
    },
    { additionalProperties: false }
  )

  /** PATCH /api/orchestration-config/:pluginId — set one or more slot model
   * refs for a plugin. Validates each non-null ref resolves. */
  app.patch(
    "/api/orchestration-config/:pluginId",
    validateJson(slotModelPatchInput),
    (c) => {
      const plugin = requirePlugin(c.req.param("pluginId"))
      const body = c.req.valid("json")
      const knownSlots = new Set(plugin.agents.map((agent) => agent.slot))
      const agentModels = { ...configStore.getAgentModels() }
      const current = { ...agentModels[plugin.id] }
      try {
        for (const [slot, ref] of Object.entries(body.slots)) {
          if (!knownSlots.has(slot)) {
            throw new RunActionError(
              "invalid_state",
              `Plugin '${plugin.id}' has no slot '${slot}'`
            )
          }
          if (ref === null || ref === "") {
            delete current[slot]
          } else {
            requireResolvableRef(ref)
            current[slot] = ref
          }
        }
      } catch (error) {
        return runError(c, error)
      }
      if (Object.keys(current).length > 0) {
        agentModels[plugin.id] = current
      } else {
        delete agentModels[plugin.id]
      }
      configStore.updateAgentModels(agentModels)
      return c.json({ [plugin.id]: current })
    }
  )
}

function runError(c: Context, error: unknown) {
  if (!(error instanceof RunActionError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found"
      ? 404
      : error.code === "launch_failed"
        ? 500
        : error.code === "capacity"
          ? 429
          : 409
  )
}

function workspaceFileError(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceFileError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found" ? 404 : 400
  )
}
