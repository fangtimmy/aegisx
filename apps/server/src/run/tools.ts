import {
  isActiveTarget,
  type TargetEndpoint,
  type TargetState,
} from "@aegisx/shared/domain"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

/** Per-run callbacks the native tools delegate to (wired by the service). */
export type RunToolContext = {
  runId: string
  challengeId: string
  /** This agent's id. */
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
 * rendering come from the same list.
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
