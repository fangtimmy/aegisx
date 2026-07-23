import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import type { AgentPublic, Message } from "../../../shared"
import {
  createWorkspaceTools,
  defineAgentTool,
  type ToolLimits,
  type WorkspaceBackend,
} from "../agent/tools"
import { isActiveTarget, type TargetState } from "../platforms/core"
import type { AgentRecord, RunAggregate } from "./types"

export type RunToolContext = {
  runId: string
  agentId: string
  isMain: boolean
  challengeId: string
  challenge: {
    platformIntegrated: boolean
    targetCapable: boolean
  }
  backend: WorkspaceBackend
  toolLimits?: ToolLimits
  getRun(): RunAggregate | null
  requestFinish(summary: string): void
  getAgent(agentId: string): AgentRecord | undefined
  messagesForAgent(agentId: string): Message[]
  spawnChild(
    name: string,
    task: string,
    signal?: AbortSignal
  ): Promise<AgentPublic>
  canFinishRun?(runId: string, challengeId: string): boolean
  submitFlag?(
    runId: string,
    challengeId: string,
    flag?: string,
    signal?: AbortSignal
  ): Promise<unknown>
  targetAction?(
    challengeId: string,
    action: "get" | "start" | "extend" | "stop",
    signal?: AbortSignal
  ): Promise<TargetState>
}

function lastAssistantText(entries: Message[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]
    if (message?.role !== "assistant") continue
    const text = message.content
      .flatMap((part) =>
        typeof part === "string"
          ? [part]
          : part.type === "text"
            ? [part.text]
            : []
      )
      .join("\n")
      .trim()
    if (text) return text.slice(0, 50_000)
  }
  return null
}

export function createRunTools(context: RunToolContext): AgentTool[] {
  const { backend, isMain, challenge } = context
  const workspaceTools = context.toolLimits
    ? createWorkspaceTools(backend, context.toolLimits)
    : createWorkspaceTools(backend)

  const finishRun = defineAgentTool({
    name: "finish_run",
    label: "Finish run",
    description: "Mark this challenge run complete and stop further work",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1 }),
    }),
    execute: async (_id, params, signal) => {
      const stored = context.getRun()
      if (
        !stored ||
        ["completed", "failed", "stopped"].includes(stored.status)
      ) {
        throw new Error("Run is already finished")
      }
      if (!context.canFinishRun?.(context.runId, context.challengeId)) {
        throw new Error("Submit an accepted flag before finishing this Run")
      }
      if (challenge.targetCapable && context.targetAction) {
        const target = await context.targetAction(
          context.challengeId,
          "get",
          signal
        )
        if (isActiveTarget(target)) {
          throw new Error("Stop the remote target before finishing this Run")
        }
      }
      context.requestFinish(params.summary)
      return {
        content: [{ type: "text" as const, text: "Run completed" }],
        details: {},
        terminate: true,
      }
    },
    executionMode: "sequential",
  })

  const submitFlag = defineAgentTool({
    name: "submit_flag",
    label: "Submit flag",
    description: "Submit a candidate flag to the connected CTF platform",
    parameters: Type.Object({ flag: Type.String({ minLength: 1 }) }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      if (!context.submitFlag) throw new Error("Flag submission is unavailable")
      const result = await context.submitFlag(
        context.runId,
        context.challengeId,
        params.flag,
        signal
      )
      if (!result) throw new Error("Flag submission is unavailable")
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      }
    },
  })

  const spawnAgent = defineAgentTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description:
      "Start a background child agent for a focused task. Completion is delivered automatically; do not poll repeatedly.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 80 }),
      task: Type.String({ minLength: 1, maxLength: 100_000 }),
    }),
    executionMode: "parallel",
    execute: async (_id, params, signal) => {
      if (signal?.aborted) throw new Error("Sub-agent creation was aborted")
      const child = await context.spawnChild(
        params.name.trim(),
        params.task.trim(),
        signal
      )
      return {
        content: [
          {
            type: "text" as const,
            text: `Started ${child.name} in the background with agent ID ${child.id}. It shares the Run workspace. Completion will be delivered automatically.`,
          },
        ],
        details: {
          agentId: child.id,
          status: child.status,
          workspace: ".",
        },
      }
    },
  })

  const inspectAgent = defineAgentTool({
    name: "inspect_agent",
    label: "Inspect agent",
    description:
      "Read a child agent status and latest output when needed. Completion is delivered automatically.",
    parameters: Type.Object({
      agent_id: Type.String({ minLength: 1 }),
    }),
    execute: async (_id, params) => {
      const child = context.getAgent(params.agent_id)
      if (
        !child ||
        child.runId !== context.runId ||
        child.parentAgentId !== context.agentId
      ) {
        throw new Error("Child agent was not found")
      }
      const summary =
        child.summary ?? lastAssistantText(context.messagesForAgent(child.id))
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: child.id,
              name: child.name,
              status: child.status,
              summary,
              error: child.error,
            }),
          },
        ],
        details: { found: true },
      }
    },
  })

  const targetTool = (
    name: "get_target" | "start_target" | "extend_target" | "stop_target",
    label: string,
    description: string,
    action: "get" | "start" | "extend" | "stop"
  ) =>
    defineAgentTool({
      name,
      label,
      description,
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, _params, signal) => {
        if (!context.targetAction)
          throw new Error("Target management is unavailable")
        const target = await context.targetAction(
          context.challengeId,
          action,
          signal
        )
        return {
          content: [{ type: "text" as const, text: JSON.stringify(target) }],
          details: target,
        }
      },
    })

  const targetTools =
    isMain && challenge.targetCapable && context.targetAction
      ? [
          targetTool(
            "get_target",
            "Get target",
            "Get the current remote challenge target status and endpoints",
            "get"
          ),
          targetTool(
            "start_target",
            "Start target",
            "Start the remote challenge target and wait until it is ready",
            "start"
          ),
          targetTool(
            "extend_target",
            "Extend target",
            "Extend the remote challenge target lifetime",
            "extend"
          ),
          targetTool(
            "stop_target",
            "Stop target",
            "Stop the remote challenge target",
            "stop"
          ),
        ]
      : []

  return [
    ...workspaceTools,
    ...(isMain
      ? [
          finishRun,
          ...(challenge.platformIntegrated ? [submitFlag] : []),
          spawnAgent,
          inspectAgent,
          ...targetTools,
        ]
      : []),
  ]
}
