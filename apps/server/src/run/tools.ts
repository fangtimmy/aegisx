import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AgentSummary } from "../../../shared/agent"
import {
  isActiveTarget,
  type TargetEndpoint,
  type TargetState,
} from "../../../shared/target"

/** Per-run callbacks the native tools delegate to (wired by the service). */
export type RunToolContext = {
  runId: string
  challengeId: string
  /** This agent's id (validates child ownership for inspect_agent). */
  agentId: string
  submitFlag(
    flag: string
  ): Promise<{ status: string; message?: string; remoteId?: string } | null>
  targetAction(
    action: "get" | "start" | "extend" | "stop"
  ): Promise<TargetState>
  /** Schedule a graceful finish after the current tool batch completes. */
  requestFinish(summary: string): void
  /** Start a background child agent; resolves immediately with the new agent. */
  spawnChild(input: {
    name: string
    task: string
  }): Promise<{ agentId: string; name: string; status: string }>
  /** Whether an accepted flag submission exists for this run. */
  hasAcceptedFlag(): Promise<boolean>
  /** Look up an agent in this run (for inspect_agent). */
  getAgent(agentId: string): AgentSummary | undefined
  /** Latest assistant text for an agent (for inspect_agent). */
  lastAssistantText(agentId: string): string | null
}

export type ToolCapabilities = {
  canSubmitFlag: boolean
  canManageTarget: boolean
  canSpawnAgent: boolean
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  }
}

/** Build the main agent's native tools based on run capabilities. */
export function createMainTools(ctx: RunToolContext, caps: ToolCapabilities) {
  const tools = []

  tools.push(
    defineTool({
      name: "finish_run",
      label: "Finish run",
      description:
        "Mark this run complete and stop further work. Call only after the solution is backed by reproducible evidence: when platform submission is available, an accepted flag must come first; when a remote target exists, it must be stopped first.",
      parameters: Type.Object({
        summary: Type.String({
          description:
            "One-paragraph summary: approach, evidence, flag, outcome.",
          minLength: 1,
        }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        if (caps.canSubmitFlag && !(await ctx.hasAcceptedFlag())) {
          throw new Error("Submit an accepted flag before finishing this Run")
        }
        if (caps.canManageTarget) {
          const target = await ctx.targetAction("get")
          if (isActiveTarget(target)) {
            throw new Error("Stop the remote target before finishing this Run")
          }
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

  if (caps.canSubmitFlag) {
    tools.push(
      defineTool({
        name: "submit_flag",
        label: "Submit flag",
        description:
          "Submit a candidate flag to the challenge's platform. Use only for high-confidence candidates derived from evidence.",
        parameters: Type.Object({
          flag: Type.String({
            description: "The flag string to submit.",
            minLength: 1,
          }),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const result = await ctx.submitFlag(params.flag)
          if (!result) {
            return textResult(
              "This challenge is not managed by a platform. Record the flag in WRITEUP.md instead."
            )
          }
          return textResult(
            `Flag submission verdict: ${result.status}${
              result.message ? ` — ${result.message}` : ""
            }`,
            result
          )
        },
      })
    )
  }

  if (caps.canManageTarget) {
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

    tools.push(
      targetTool(
        "get_target",
        "Get target",
        "Get the current remote challenge target status and endpoints. Call before starting.",
        "get"
      ),
      targetTool(
        "start_target",
        "Start target",
        "Start the remote challenge target.",
        "start"
      ),
      targetTool(
        "extend_target",
        "Extend target",
        "Extend the remote challenge target lifetime. Call before it expires.",
        "extend"
      ),
      targetTool(
        "stop_target",
        "Stop target",
        "Stop the remote challenge target. Call before finishing the run.",
        "stop"
      )
    )
  }

  if (caps.canSpawnAgent) {
    tools.push(
      defineTool({
        name: "spawn_agent",
        label: "Spawn agent",
        description:
          "Start a background child agent for a focused, self-contained sub-task. It shares your workspace but cannot submit flags, finish, manage targets, or spawn further agents. Reserve it for tasks heavy enough to deserve a dedicated turn. Completion is delivered automatically — do not poll repeatedly.",
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
      }),
      defineTool({
        name: "inspect_agent",
        label: "Inspect agent",
        description:
          "Read a child agent's current status and latest output. Completion is normally delivered automatically; use this only when you must check on a running child.",
        parameters: Type.Object({
          agent_id: Type.String({
            description: "The child agent id (returned by spawn_agent).",
            minLength: 1,
          }),
        }),
        execute: async (_id, params) => {
          const child = ctx.getAgent(params.agent_id)
          if (child?.role !== "child" || child?.parentAgentId !== ctx.agentId) {
            throw new Error("Child agent was not found")
          }
          const summary = ctx.lastAssistantText(child.id) ?? "(no output yet)"
          return textResult(
            JSON.stringify({
              id: child.id,
              name: child.name,
              status: child.status,
              summary,
              error: child.error,
            }),
            { found: true }
          )
        },
      })
    )
  }

  return tools
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
