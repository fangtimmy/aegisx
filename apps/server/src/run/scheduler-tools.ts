import type { AgentSummary, Challenge, RunPublic } from "@aegisx/shared"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { QueueItemPublic } from "./queue"

/** Compact run view for the scheduler's read-only tools. */
export type RunSummary = {
  id: string
  scopeType: "challenge" | "event"
  eventId: string
  challengeId: string | null
  challengeName: string
  orchestration: string
  status: RunPublic["status"]
  source: RunPublic["source"]
  modelId: string
  modelName: string
  summary: string | null
  error: string | null
  hasAcceptedFlag: boolean
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** Fence + active-run snapshot returned by get_status. */
export type SchedulerStatusSnapshot = {
  maxConcurrentRuns: number
  runningCount: number
  maxConcurrentTargets: number
  activeTargetChallenges: string[]
  activeRuns: Array<{
    id: string
    challengeId: string | null
    challengeName: string
    status: string
    orchestration: string
  }>
}

/**
 * Callback bundle the scheduler (event-scope orchestrator) tools delegate to.
 * The orchestrator manages its event's task queue + sibling challenge runs; it
 * never reaches into another event. Wired by the run service from its own
 * methods + the queue service + the catalog reader.
 */
export type RunSchedulerToolContext = {
  runId: string
  eventId: string
  agentId: string
  enqueue(input: {
    challengeId: string
    orchestration?: string
    params?: Record<string, unknown>
    prompt?: string
    timeoutMs?: number | null
  }): QueueItemPublic
  listQueue(): QueueItemPublic[]
  removeQueue(itemId: string): void
  clearQueue(): void
  reorderQueue(itemIds: string[]): void
  startRun(input: {
    challengeId: string
    orchestration?: string
    params?: Record<string, unknown>
    prompt?: string
    timeoutMs?: number | null
  }): Promise<RunSummary>
  stopRun(runId: string): Promise<RunSummary>
  messageRun(
    runId: string,
    text: string,
    deliverAs?: "steer" | "followUp"
  ): Promise<RunSummary>
  closeRun(runId: string): Promise<RunSummary>
  readRun(runId: string): {
    run: RunPublic
    agents: AgentSummary[]
    entryAgentId: string | null
    lastAssistant: string | null
  }
  listRuns(filter?: {
    challengeId?: string
    status?: RunPublic["status"]
  }): RunSummary[]
  setRunTimeout(runId: string, timeoutMs: number): RunSummary
  getStatus(): SchedulerStatusSnapshot
  listChallenges(): Challenge[]
  getChallenge(challengeId: string): Challenge | undefined
  listAgents(runId: string): AgentSummary[]
  lastAssistantText(runId: string, agentId: string): string | null
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  }
}

function queueItemText(item: QueueItemPublic): string {
  return `Queue item ${item.id}: ${item.orchestration} on "${item.challengeName}" (${item.challengeId}) — ${item.status}${item.runId ? `, run ${item.runId}` : ""}${item.error ? `, error: ${item.error}` : ""}.`
}

function challengeSummaryText(c: Challenge): string {
  const solved =
    c.solved.local === "solved" ||
    c.solved.manual === "solved" ||
    c.solved.remote === "solved"
  return JSON.stringify({
    id: c.id,
    name: c.name,
    category: c.category,
    points: c.points,
    solved,
    remoteTarget: c.remoteTarget && !c.remoteTargetIgnored,
    runs: c.runStatusCounts,
  })
}

/**
 * Build the scheduler orchestrator's native tools from its persisted tool-list
 * snapshot. Each tool is gated by `has(name)` — like the solver
 * tools — so the granted set is exactly the snapshot. Names never overlap with
 * solver tools, so the two builders compose without conflict.
 */
export function createSchedulerTools(
  ctx: RunSchedulerToolContext,
  tools: string[]
) {
  const has = (name: string) => tools.includes(name)
  const created = []

  if (has("list_challenges")) {
    created.push(
      defineTool({
        name: "list_challenges",
        label: "List challenges",
        description:
          "List the event's challenges with points, category, solved state, and run activity. Use to pick what to work on; read full detail with get_challenge.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          const items = ctx.listChallenges().map(challengeSummaryText)
          return textResult(items.join("\n") || "(no challenges)", {
            count: items.length,
          })
        },
      })
    )
  }

  if (has("get_challenge")) {
    created.push(
      defineTool({
        name: "get_challenge",
        label: "Get challenge",
        description:
          "Read full detail for one challenge: description, attachments, target connectivity (ports/services), solved state, and run history. Read this before starting a challenge you do not know.",
        parameters: Type.Object({
          challenge_id: Type.String({
            minLength: 1,
            description: "The challenge id (from list_challenges).",
          }),
        }),
        execute: async (_id, params) => {
          const c = ctx.getChallenge(params.challenge_id)
          if (!c) throw new Error("Challenge not found")
          return textResult(
            JSON.stringify({
              id: c.id,
              name: c.name,
              category: c.category,
              points: c.points,
              description: c.description,
              attachments: c.attachments.map((a) => ({
                name: a.originalName,
                size: a.size,
              })),
              solved: c.solved,
              remoteTarget: c.remoteTarget && !c.remoteTargetIgnored,
              targets: c.targets,
              runs: c.runStatusCounts,
            }),
            { found: true }
          )
        },
      })
    )
  }

  if (has("list_runs")) {
    created.push(
      defineTool({
        name: "list_runs",
        label: "List runs",
        description:
          "Enumerate challenge runs (recent first), optionally filtered by challenge or status. Each item has its summary and outcome. Use to review history before re-trying a failed strategy, or to find a run id for read_run / message_run.",
        parameters: Type.Object({
          challenge_id: Type.Optional(
            Type.String({ description: "Filter by challenge id." })
          ),
          status: Type.Optional(
            Type.Union(
              [
                Type.Literal("running"),
                Type.Literal("idle"),
                Type.Literal("closed"),
              ],
              { description: "Filter by run status." }
            )
          ),
        }),
        execute: async (_id, params) => {
          const filter: {
            challengeId?: string
            status?: RunPublic["status"]
          } = {}
          if (params.challenge_id) filter.challengeId = params.challenge_id
          if (params.status) filter.status = params.status
          const items = ctx.listRuns(filter)
          return textResult(
            items.length
              ? items
                  .map((r) =>
                    JSON.stringify({
                      id: r.id,
                      challenge: r.challengeName || r.challengeId,
                      orchestration: r.orchestration,
                      status: r.status,
                      summary: r.summary,
                      error: r.error,
                      solved: r.hasAcceptedFlag,
                    })
                  )
                  .join("\n")
              : "(no runs)",
            { count: items.length }
          )
        },
      })
    )
  }

  if (has("get_status")) {
    created.push(
      defineTool({
        name: "get_status",
        label: "Get status",
        description:
          "Snapshot of concurrency / target-slot usage and active (running + idle) runs. Call before planning the next action so you respect the hard caps.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          const s = ctx.getStatus()
          return textResult(
            JSON.stringify({
              concurrency: `${s.runningCount}/${s.maxConcurrentRuns} challenge runs running`,
              targetSlots: `${s.activeTargetChallenges.length}/${s.maxConcurrentTargets} distinct targets under attack`,
              activeTargetChallenges: s.activeTargetChallenges,
              activeRuns: s.activeRuns,
            }),
            s
          )
        },
      })
    )
  }

  if (has("enqueue_run")) {
    created.push(
      defineTool({
        name: "enqueue_run",
        label: "Enqueue run",
        description:
          "Add (or re-arm) a task in the queue. Upserts by (challenge, orchestration): a hit — including done/cancelled/failed — resets to pending. The queue drains FIFO under the concurrency caps; if a slot is free the run launches right away. `prompt` overrides the run's default first prompt with your per-run strategy.",
        parameters: Type.Object({
          challenge_id: Type.String({
            minLength: 1,
            description: "The challenge id (from list_challenges).",
          }),
          orchestration: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 80,
              description:
                "Orchestration id from the catalog in your system prompt; omit for classic with defaults.",
            })
          ),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description:
                "Orchestration params; only for orchestrations marked 'requires model params'.",
            })
          ),
          prompt: Type.Optional(
            Type.String({
              maxLength: 20_000,
              description:
                "Per-run strategy that overrides the run's default first prompt.",
            })
          ),
          timeout_ms: Type.Optional(
            Type.Integer({
              minimum: 60_000,
              description: "Hard run deadline in milliseconds (minimum 60000).",
            })
          ),
        }),
        execute: async (_id, params) => {
          const item = ctx.enqueue({
            challengeId: params.challenge_id,
            ...(params.orchestration
              ? { orchestration: params.orchestration }
              : {}),
            ...(params.params ? { params: params.params } : {}),
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.timeout_ms ? { timeoutMs: params.timeout_ms } : {}),
          })
          return textResult(`Enqueued. ${queueItemText(item)}`, item)
        },
      })
    )
  }

  if (has("list_queue")) {
    created.push(
      defineTool({
        name: "list_queue",
        label: "List queue",
        description:
          "List the event's actionable queue items (pending + running + failed), FIFO. The queue content IS the plan.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          const items = ctx.listQueue()
          return textResult(
            items.length
              ? items.map(queueItemText).join("\n")
              : "(queue empty)",
            { count: items.length }
          )
        },
      })
    )
  }

  if (has("remove_queue")) {
    created.push(
      defineTool({
        name: "remove_queue",
        label: "Remove queue item",
        description:
          "Remove a queue item (pending/done/cancelled/failed). A running item cannot be removed — close its run first.",
        parameters: Type.Object({
          item_id: Type.String({
            minLength: 1,
            description: "The queue item id (from list_queue).",
          }),
        }),
        execute: async (_id, params) => {
          ctx.removeQueue(params.item_id)
          return textResult(`Removed queue item ${params.item_id}.`)
        },
      })
    )
  }

  if (has("clear_queue")) {
    created.push(
      defineTool({
        name: "clear_queue",
        label: "Clear queue",
        description:
          "Remove every non-running queue item (pending + failed) for the event. Running items are kept.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          ctx.clearQueue()
          return textResult("Cleared non-running queue items.")
        },
      })
    )
  }

  if (has("reorder_queue")) {
    created.push(
      defineTool({
        name: "reorder_queue",
        label: "Reorder queue",
        description:
          "Reorder pending queue items by listing their ids in the desired order (front first). Running/failed items keep their place. Pass every pending item id you care about.",
        parameters: Type.Object({
          item_ids: Type.Array(
            Type.String({
              minLength: 1,
              description: "Pending queue item id (front first).",
            })
          ),
        }),
        execute: async (_id, params) => {
          ctx.reorderQueue(params.item_ids)
          return textResult(`Reordered ${params.item_ids.length} item(s).`)
        },
      })
    )
  }

  if (has("start_run")) {
    created.push(
      defineTool({
        name: "start_run",
        label: "Start run",
        description:
          "Start a fresh solver run directly (escape hatch — bypasses the queue). The initial prompt is your per-run strategy; be specific. A concurrency/target-slot rejection comes back as a reason — adjust your plan, do not retry blindly. Prefer enqueue_run for planned work; use this only when you need a run immediately.",
        parameters: Type.Object({
          challenge_id: Type.String({
            minLength: 1,
            description: "The challenge id (from list_challenges).",
          }),
          orchestration: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 80,
              description:
                "Orchestration id from the catalog in your system prompt; omit for classic with defaults.",
            })
          ),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description:
                "Orchestration params; only for orchestrations marked 'requires model params'.",
            })
          ),
          prompt: Type.Optional(
            Type.String({
              maxLength: 20_000,
              description:
                "Per-run strategy that overrides the run's default first prompt.",
            })
          ),
          timeout_ms: Type.Optional(
            Type.Integer({
              minimum: 60_000,
              description: "Hard run deadline in milliseconds (minimum 60000).",
            })
          ),
        }),
        execute: async (_id, params) => {
          const run = await ctx.startRun({
            challengeId: params.challenge_id,
            ...(params.orchestration
              ? { orchestration: params.orchestration }
              : {}),
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.timeout_ms ? { timeoutMs: params.timeout_ms } : {}),
          })
          return textResult(
            `Started run ${run.id} (${run.orchestration}) on challenge ${params.challenge_id}.`,
            run
          )
        },
      })
    )
  }

  if (has("stop_run")) {
    created.push(
      defineTool({
        name: "stop_run",
        label: "Stop run",
        description:
          "Abort a run's current turn (→ idle; container kept warm). Use to cut a stuck or off-track running turn before message_run with new direction.",
        parameters: Type.Object({
          run_id: Type.String({
            minLength: 1,
            description: "The run id (from list_runs).",
          }),
        }),
        execute: async (_id, params) => {
          const run = await ctx.stopRun(params.run_id)
          return textResult(`Stopped run ${run.id} → ${run.status}.`, run)
        },
      })
    )
  }

  if (has("message_run")) {
    created.push(
      defineTool({
        name: "message_run",
        label: "Message run",
        description:
          "Send guidance to a run (its entry agent). On an idle or closed run this starts/continues a turn (a closed run is cold-restored, keeping its context + workspace); on a running run, deliverAs steers (steer) or queues (followUp) into the current turn. Prefer this over stop+restart when the solver has useful context.",
        parameters: Type.Object({
          run_id: Type.String({
            minLength: 1,
            description: "The run id (from list_runs).",
          }),
          text: Type.String({
            minLength: 1,
            maxLength: 20_000,
            description: "The guidance or question to send.",
          }),
          deliver_as: Type.Optional(
            Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
              description:
                "On a running run: 'steer' into the current turn, or 'followUp' queued after it. Ignored on idle/closed runs.",
            })
          ),
        }),
        execute: async (_id, params) => {
          const run = await ctx.messageRun(
            params.run_id,
            params.text,
            params.deliver_as
          )
          return textResult(
            `Delivered to run ${run.id} (now ${run.status}).`,
            run
          )
        },
      })
    )
  }

  if (has("close_run")) {
    created.push(
      defineTool({
        name: "close_run",
        label: "Close run",
        description:
          "Release a run's container (→ closed; session + history kept, resumable later with message_run). Use to free resources on runs you are pausing or done actively working.",
        parameters: Type.Object({
          run_id: Type.String({
            minLength: 1,
            description: "The run id (from list_runs).",
          }),
        }),
        execute: async (_id, params) => {
          const run = await ctx.closeRun(params.run_id)
          return textResult(`Closed run ${run.id}.`, run)
        },
      })
    )
  }

  if (has("read_run")) {
    created.push(
      defineTool({
        name: "read_run",
        label: "Read run",
        description:
          "Read a run's status, agents, and the entry agent's latest output. Use to assess a run's progress before steering or closing it.",
        parameters: Type.Object({
          run_id: Type.String({
            minLength: 1,
            description: "The run id (from list_runs).",
          }),
        }),
        execute: async (_id, params) => {
          const r = ctx.readRun(params.run_id)
          return textResult(
            JSON.stringify({
              run: {
                id: r.run.id,
                challenge: r.run.challengeName,
                orchestration: r.run.orchestration,
                status: r.run.status,
                summary: r.run.summary,
                error: r.run.error,
                solved: r.run.hasAcceptedFlag,
              },
              entryAgentId: r.entryAgentId,
              agents: r.agents.map((a) => ({
                id: a.id,
                role: a.role,
                status: a.status,
              })),
              lastAssistant: r.lastAssistant ?? "(no output yet)",
            }),
            { found: true }
          )
        },
      })
    )
  }

  if (has("set_run_timeout")) {
    created.push(
      defineTool({
        name: "set_run_timeout",
        label: "Set run timeout",
        description:
          "Set or extend a run's hard deadline (milliseconds from now). Usable on running/idle runs (re-arms the timer) and closed runs (applies on next resume).",
        parameters: Type.Object({
          run_id: Type.String({
            minLength: 1,
            description: "The run id (from list_runs).",
          }),
          timeout_ms: Type.Integer({
            minimum: 60_000,
            description:
              "Hard deadline in milliseconds from now (minimum 60000).",
          }),
        }),
        execute: async (_id, params) => {
          const run = ctx.setRunTimeout(params.run_id, params.timeout_ms)
          return textResult(
            `Run ${run.id} deadline set to ${params.timeout_ms}ms from now.`,
            run
          )
        },
      })
    )
  }

  if (has("list_agents")) {
    created.push(
      defineTool({
        name: "list_agents",
        label: "List agents",
        description:
          "Enumerate the agents in a run (id, name, role, status). Use to inspect a run's internal agent layout.",
        parameters: Type.Object({
          run_id: Type.Optional(
            Type.String({
              minLength: 1,
              description: "The run id; defaults to your own run when omitted.",
            })
          ),
        }),
        execute: async (_id, params) => {
          const runId = params.run_id ?? ctx.runId
          const agents = ctx.listAgents(runId).map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            status: a.status,
          }))
          return textResult(JSON.stringify(agents), { count: agents.length })
        },
      })
    )
  }

  return created
}
