import type { AgentSummary } from "@aegisx/shared/agent"
import {
  isActiveTarget,
  type TargetEndpoint,
  type TargetState,
} from "@aegisx/shared/target"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

/** Per-run callbacks the native tools delegate to (wired by the service). */
export type RunToolContext = {
  runId: string
  challengeId: string
  /** This agent's id (peer tools resolve targets within the run). */
  agentId: string
  submitFlag(
    flag: string,
    verifyRemote?: boolean
  ): Promise<{
    status: string
    message?: string
    remoteId?: string
    verified?: boolean
  } | null>
  targetAction(
    action: "get" | "start" | "extend" | "stop"
  ): Promise<TargetState>
  /** Schedule a graceful finish after the current tool batch completes. */
  requestFinish(summary: string): void
  /** Whether this run already recorded an accepted flag (finish_run guard). */
  hasAcceptedFlag(): boolean
  /** Whether finish_run already warned this run about a missing flag. */
  finishFlagWarned(): boolean
  markFinishFlagWarned(): void
  /** Start a background child agent; resolves immediately with the new agent. */
  spawnChild(input: {
    name: string
    task: string
  }): Promise<{ agentId: string; name: string; status: string }>
  /** Send a message to another agent in this run (auto-prepares it). */
  messageAgent(
    agentId: string,
    text: string
  ): Promise<{ ok: boolean; error?: string }>
  /** Look up an agent in this run (peer read + spawn children). */
  getAgent(agentId: string): AgentSummary | undefined
  /** Enumerate this run's agents. */
  listAgents(): AgentSummary[]
  /** Latest assistant text for an agent. */
  lastAssistantText(agentId: string): string | null
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  }
}

/**
 * Build an agent's native tools from its persisted tool-list snapshot. The
 * snapshot is the single source of truth — the tools created here are exactly
 * the granted names (finish_run only when the snapshot has it, so a bootstrap
 * agent truly has no finish capability), and capabilities derived for prompt
 * rendering come from the same list (§3.7).
 */
export function createMainTools(ctx: RunToolContext, tools: string[]) {
  const has = (name: string) => tools.includes(name)
  const created = []

  if (has("finish_run")) {
    created.push(
      defineTool({
        name: "finish_run",
        label: "Finish run",
        description:
          "Declare the run complete and stop further work. This terminates the ENTIRE run, including other agents. Call only once the solution is backed by reproducible evidence; when a remote target exists, it must be stopped first. If no flag has been accepted yet, the tool warns once — submit the flag first when you solved the challenge.",
        parameters: Type.Object({
          summary: Type.String({
            description:
              "One-paragraph summary: approach, evidence, flag, outcome.",
            minLength: 1,
          }),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          if (has("stop_target")) {
            const target = await ctx.targetAction("get")
            if (isActiveTarget(target)) {
              throw new Error(
                "Stop the remote target before finishing this Run"
              )
            }
          }
          // Don't lose a solved flag: cheap models tend to finish without
          // submitting. Warn once per run (unsolved runs finish on the second
          // call); the stop_target check above is the hard variant of the same
          // guard.
          if (!ctx.hasAcceptedFlag() && !ctx.finishFlagWarned()) {
            ctx.markFinishFlagWarned()
            return textResult(
              "No accepted flag on this run. If you solved the challenge, call submit_flag with the flag first, then finish_run again. If you did not solve it, call finish_run again to confirm."
            )
          }
          ctx.requestFinish(params.summary.trim())
          return {
            content: [{ type: "text" as const, text: "Run completed" }],
            details: {},
            // Hint the agent loop to stop after this tool batch.
            terminate: true,
          }
        },
      })
    )
  }

  if (has("submit_flag")) {
    created.push(
      defineTool({
        name: "submit_flag",
        label: "Submit flag",
        description:
          "Record a candidate flag for the challenge and (by default) verify it against the platform. Use only for high-confidence candidates derived from evidence. For platform challenges `verify_remote` contacts the remote judge; set it to false to record a candidate locally without consuming a remote submission (e.g. when batching, or the remote is unavailable). For non-platform challenges the flag is recorded as locally accepted regardless.",
        parameters: Type.Object({
          flag: Type.String({
            description: "The flag string to submit.",
            minLength: 1,
          }),
          verify_remote: Type.Optional(
            Type.Boolean({
              description:
                "Whether to verify against the remote platform (default true). Only meaningful for platform-managed challenges; when false the flag is recorded as a pending candidate.",
            })
          ),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const verifyRemote = params.verify_remote ?? true
          const result = await ctx.submitFlag(params.flag, verifyRemote)
          if (!result) {
            return textResult("Flag could not be recorded.")
          }
          const suffix = result.message ? ` — ${result.message}` : ""
          const note =
            result.verified === false && result.status === "pending"
              ? " (recorded as candidate; not verified remotely)"
              : result.verified === false && result.status === "accepted"
                ? " (recorded locally; no remote verification)"
                : ""
          return textResult(
            `Flag submission verdict: ${result.status}${suffix}${note}`,
            result
          )
        },
      })
    )
  }

  if (
    has("get_target") ||
    has("start_target") ||
    has("extend_target") ||
    has("stop_target")
  ) {
    const targetTool = (
      name: "get_target" | "start_target" | "extend_target" | "stop_target",
      label: string,
      description: string,
      action: "get" | "start" | "extend" | "stop"
    ) =>
      defineTool({
        name,
        label,
        description,
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute: async () => {
          const state = await ctx.targetAction(action)
          return textResult(formatTarget(state), state)
        },
      })

    if (has("get_target")) {
      created.push(
        targetTool(
          "get_target",
          "Get target",
          "Get the current remote challenge target status and endpoints. Call before starting.",
          "get"
        )
      )
    }
    if (has("start_target")) {
      created.push(
        targetTool(
          "start_target",
          "Start target",
          "Start the remote challenge target.",
          "start"
        )
      )
    }
    if (has("extend_target")) {
      created.push(
        targetTool(
          "extend_target",
          "Extend target",
          "Extend the remote challenge target lifetime. Call before it expires.",
          "extend"
        )
      )
    }
    if (has("stop_target")) {
      created.push(
        targetTool(
          "stop_target",
          "Stop target",
          "Stop the remote challenge target. Call before finishing the run.",
          "stop"
        )
      )
    }
  }

  if (has("spawn_agent")) {
    created.push(
      defineTool({
        name: "spawn_agent",
        label: "Spawn agent",
        description:
          "Start a background child agent for a focused, self-contained sub-task. It shares your workspace but cannot submit flags, finish, manage targets, or spawn further agents. Only one child runs at a time per run — wait for it to finish before spawning another. Reserve it for tasks heavy enough to deserve a dedicated turn. Completion is delivered automatically — do not poll repeatedly.",
        parameters: Type.Object({
          name: Type.String({
            description: "Short name for the child agent.",
            minLength: 1,
            maxLength: 80,
          }),
          task: Type.String({
            description:
              "One concrete, self-contained task with clear acceptance criteria.",
            minLength: 1,
            maxLength: 100_000,
          }),
        }),
        executionMode: "parallel",
        execute: async (_id, params) => {
          const child = await ctx.spawnChild({
            name: params.name.trim(),
            task: params.task.trim(),
          })
          return textResult(
            `Started ${child.name} in the background (agent ${child.agentId}). It shares the workspace. Completion will be delivered automatically — do not poll repeatedly.`,
            { agentId: child.agentId, status: child.status }
          )
        },
      })
    )
  }

  if (has("message_agent")) {
    created.push(
      defineTool({
        name: "message_agent",
        label: "Message agent",
        description:
          "Send a message to another agent in this run (by id). While that agent is streaming this steers into its current turn; otherwise it starts a fresh turn for it. Use for coordination (observer → solver, peer → peer); do not poll — events drive the loop.",
        parameters: Type.Object({
          agent_id: Type.String({
            description: "The target agent id (from list_agents / read_agent).",
            minLength: 1,
          }),
          text: Type.String({
            description: "The guidance or question to send.",
            minLength: 1,
          }),
        }),
        execute: async (_id, params) => {
          const result = await ctx.messageAgent(
            params.agent_id,
            params.text.trim()
          )
          if (!result.ok) throw new Error(result.error ?? "Agent not found")
          return textResult(`Message delivered to agent ${params.agent_id}.`, {
            delivered: true,
          })
        },
      })
    )
  }

  if (has("read_agent")) {
    created.push(
      defineTool({
        name: "read_agent",
        label: "Read agent",
        description:
          "Read another agent in this run (by id): its status and latest output. Use to review a peer's or child's progress. Completion is normally delivered automatically — use this when you must check in.",
        parameters: Type.Object({
          agent_id: Type.String({
            description: "The agent id (from list_agents / spawn_agent).",
            minLength: 1,
          }),
        }),
        execute: async (_id, params) => {
          const agent = ctx.getAgent(params.agent_id)
          if (!agent) throw new Error("Agent was not found in this run")
          const summary = ctx.lastAssistantText(agent.id) ?? "(no output yet)"
          return textResult(
            JSON.stringify({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              status: agent.status,
              summary,
              error: agent.error,
            }),
            { found: true }
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
          "Enumerate the agents in this run (id, name, role, status). Use to discover agent ids before read_agent / message_agent.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          const agents = ctx.listAgents().map((a) => ({
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

/**
 * Human-readable target summary, including per-endpoint `guidance` (e.g. the
 * Ret2Shell WSRX tunnel `wsrx connect ...` instructions) so the agent learns
 * how to reach tunnel endpoints.
 */
function formatTarget(state: TargetState): string {
  const lines = [`Target status: ${state.status}`]
  if (state.expiresAt) lines.push(`Expires at: ${state.expiresAt}`)
  for (const endpoint of state.endpoints) {
    lines.push(`- ${endpoint.name}: ${endpoint.address} (${endpoint.protocol})`)
    for (const guidanceLine of endpointGuidance(endpoint)) {
      lines.push(`  ${guidanceLine}`)
    }
  }
  if (state.message) lines.push(`Message: ${state.message}`)
  return lines.join("\n")
}

function endpointGuidance(endpoint: TargetEndpoint): readonly string[] {
  return endpoint.guidance ?? []
}
