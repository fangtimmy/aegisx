import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { TargetState } from "../../../shared/target"

/** Per-run callbacks the native tools delegate to (wired by the service). */
export type RunToolContext = {
  runId: string
  challengeId: string
  submitFlag(
    flag: string
  ): Promise<{ status: string; message?: string; remoteId?: string } | null>
  targetAction(
    action: "get" | "start" | "extend" | "stop"
  ): Promise<TargetState>
  /** Schedule a graceful finish after the current tool batch completes. */
  requestFinish(summary: string): void
  spawnChild(input: { task: string; name?: string }): Promise<{
    summary: string
    agentId: string
    status: string
    messageCount: number
    error?: string
  }>
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
        execute: async (_id, params) => {
          try {
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
          } catch (error) {
            return textResult(
              `Flag submission failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          }
        },
      })
    )
  }

  tools.push(
    defineTool({
      name: "finish_run",
      label: "Finish run",
      description:
        "Finish the run with a concise evidence-based summary. Call once the solution is backed by reproducible evidence. Stops the run; do not continue after calling it.",
      parameters: Type.Object({
        summary: Type.String({
          description:
            "One-paragraph summary: approach, evidence, flag, outcome.",
          minLength: 1,
        }),
      }),
      execute: async (_id, params) => {
        ctx.requestFinish(params.summary.trim())
        return {
          content: [{ type: "text" as const, text: "Run finish requested." }],
          details: {},
          // Hint the agent loop to stop after this tool batch.
          terminate: true,
        }
      },
    })
  )

  if (caps.canManageTarget) {
    tools.push(
      defineTool({
        name: "target_get",
        label: "Inspect target",
        description:
          "Inspect the challenge's remote target status and endpoints. Call before starting.",
        parameters: Type.Object({}),
        execute: async () => {
          const state = await ctx.targetAction("get")
          return textResult(formatTarget(state), state)
        },
      }),
      defineTool({
        name: "target_start",
        label: "Start target",
        description: "Start the challenge's remote target.",
        parameters: Type.Object({}),
        execute: async () => {
          const state = await ctx.targetAction("start")
          return textResult(formatTarget(state), state)
        },
      }),
      defineTool({
        name: "target_extend",
        label: "Extend target",
        description:
          "Extend the remote target's lifetime to preserve session/state. Call before it expires.",
        parameters: Type.Object({}),
        execute: async () => {
          const state = await ctx.targetAction("extend")
          return textResult(formatTarget(state), state)
        },
      }),
      defineTool({
        name: "target_stop",
        label: "Stop target",
        description:
          "Stop the challenge's remote target. Call before finishing the run.",
        parameters: Type.Object({}),
        execute: async () => {
          const state = await ctx.targetAction("stop")
          return textResult(formatTarget(state), state)
        },
      })
    )
  }

  if (caps.canSpawnAgent) {
    tools.push(
      defineTool({
        name: "spawn_agent",
        label: "Spawn child agent",
        description:
          "Delegate a bounded, self-contained sub-task to a child agent that shares your workspace. It cannot submit flags, finish the run, manage targets, or spawn further agents. Reserve for tasks heavy enough to deserve a dedicated turn.",
        parameters: Type.Object({
          task: Type.String({
            description:
              "One concrete, self-contained task with clear acceptance criteria.",
            minLength: 1,
          }),
          name: Type.Optional(
            Type.String({
              description: "Optional short name for the child agent.",
              maxLength: 80,
            })
          ),
        }),
        execute: async (_id, params) => {
          const result = await ctx.spawnChild({
            task: params.task,
            name: params.name,
          })
          return textResult(
            [
              `Child agent "${result.agentId}" finished (status: ${result.status}, ${result.messageCount} messages).`,
              result.error ? `Error: ${result.error}` : "",
              `Summary:\n${result.summary}`,
            ]
              .filter(Boolean)
              .join("\n"),
            result
          )
        },
      })
    )
  }

  return tools
}

function formatTarget(state: TargetState): string {
  const lines = [`Target status: ${state.status}`]
  if (state.expiresAt) lines.push(`Expires at: ${state.expiresAt}`)
  for (const endpoint of state.endpoints) {
    lines.push(`- ${endpoint.name}: ${endpoint.address} (${endpoint.protocol})`)
  }
  if (state.message) lines.push(`Message: ${state.message}`)
  return lines.join("\n")
}
