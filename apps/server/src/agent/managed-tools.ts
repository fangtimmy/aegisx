import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import {
  defaultSettings,
  type SettingsPublic,
} from "../infrastructure/config-store"

export type ToolTerminal = "timed_out" | "cancelled" | "failed"

export type ToolTimeoutSettings = Pick<
  SettingsPublic,
  "defaultToolTimeoutMs" | "toolTimeouts"
>

export type ToolCallMeta = {
  toolCallId: string
  toolName: string
  terminal?: ToolTerminal
  terminalMessage?: string
}

/** Per-agent in-memory tool terminal status (no agent_tool_calls table in v2). */
const terminalByAgent = new Map<string, Map<string, ToolCallMeta>>()

export function getToolTerminal(
  agentId: string,
  toolCallId: string
): ToolCallMeta | undefined {
  return terminalByAgent.get(agentId)?.get(toolCallId)
}

export function clearToolTerminals(agentId: string) {
  terminalByAgent.delete(agentId)
}

export function resolveToolTimeoutMs(
  toolName: string,
  args: unknown,
  settings: ToolTimeoutSettings
): number {
  if (toolName === "bash" && args && typeof args === "object") {
    if ("background" in args && args.background === true) {
      // Only covers spawn/setup; the process itself is detached.
      return 15_000
    }
    if ("timeout" in args && typeof args.timeout === "number") {
      return args.timeout * 1000 + 1000
    }
  }
  return settings.toolTimeouts[toolName] ?? settings.defaultToolTimeoutMs
}

export function createToolTimeoutResolver(
  getSettings: () => ToolTimeoutSettings
): (toolName: string, args: unknown) => number {
  return (toolName, args) => resolveToolTimeoutMs(toolName, args, getSettings())
}

function resultBytes(content: AgentToolResult<unknown>["content"]) {
  return content.reduce(
    (total, part) =>
      total +
      (part.type === "text"
        ? Buffer.byteLength(part.text)
        : Buffer.byteLength(part.data, "base64")),
    0
  )
}

class ToolTimeoutError extends Error {}
class ToolCancelledError extends Error {}

function timeoutMessage(toolName: string, timeoutMs: number) {
  const message = `${toolName} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
  return ["start_target", "submit_flag"].includes(toolName)
    ? `${message} The remote outcome may be unknown; inspect current state before retrying.`
    : message
}

function setTerminal(
  agentId: string,
  toolCallId: string,
  toolName: string,
  terminal: ToolTerminal,
  terminalMessage: string
) {
  let map = terminalByAgent.get(agentId)
  if (!map) {
    map = new Map()
    terminalByAgent.set(agentId, map)
  }
  map.set(toolCallId, { toolCallId, toolName, terminal, terminalMessage })
}

export function manageAgentTools(
  agentId: string,
  tools: AgentTool[],
  resolve: (toolName: string, args: unknown) => number = (name, args) =>
    resolveToolTimeoutMs(name, args, defaultSettings)
): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const timeoutMs = resolve(tool.name, args)
      const controller = new AbortController()
      const cancel = () =>
        controller.abort(new ToolCancelledError(`${tool.name} was cancelled`))
      signal?.addEventListener("abort", cancel, { once: true })
      if (signal?.aborted) cancel()
      const timer = setTimeout(
        () =>
          controller.abort(
            new ToolTimeoutError(timeoutMessage(tool.name, timeoutMs))
          ),
        timeoutMs
      )
      const aborted = new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener("abort", rejectAbort, { once: true })
        if (controller.signal.aborted) rejectAbort()
      })
      const execution = Promise.resolve().then(() =>
        tool.execute(toolCallId, args, controller.signal, onUpdate)
      )
      void execution.catch(() => undefined)

      try {
        const result = await Promise.race([execution, aborted])
        // touch resultBytes for future stats hooks
        void resultBytes(result.content)
        return result
      } catch (rawError) {
        const cause = controller.signal.aborted
          ? controller.signal.reason
          : rawError
        const terminal: ToolTerminal =
          cause instanceof ToolTimeoutError
            ? "timed_out"
            : cause instanceof ToolCancelledError
              ? "cancelled"
              : "failed"
        const error = cause instanceof Error ? cause.message : String(cause)
        setTerminal(agentId, toolCallId, tool.name, terminal, error)
        throw cause
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", cancel)
      }
    },
  }))
}
