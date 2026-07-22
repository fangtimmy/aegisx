import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { eq } from "drizzle-orm"
import type { createDatabase } from "../db"
import { agentToolCalls } from "../db/schema"
import {
  defaultSettings,
  type SettingsData,
} from "../infrastructure/config-store"

type Database = ReturnType<typeof createDatabase>["db"]
type ToolStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "abandoned"

export type ToolTimeoutSettings = Pick<
  SettingsData,
  "defaultToolTimeoutMs" | "toolTimeouts"
>

export type ToolTimeoutResolver = (
  toolName: string,
  args: unknown,
  settings: ToolTimeoutSettings
) => number

export function resolveToolTimeoutMs(
  toolName: string,
  args: unknown,
  settings: ToolTimeoutSettings
): number {
  if (
    toolName === "bash" &&
    args &&
    typeof args === "object" &&
    "timeout" in args &&
    typeof args.timeout === "number"
  ) {
    return args.timeout * 1000 + 1000
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

function resultDetails(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const details = value as Record<string, unknown>
  return {
    outputBytes:
      typeof details.outputBytes === "number" && details.outputBytes >= 0
        ? details.outputBytes
        : undefined,
    truncated: details.truncated === true,
    exitCode:
      typeof details.exitCode === "number" && Number.isInteger(details.exitCode)
        ? details.exitCode
        : undefined,
  }
}

class ToolTimeoutError extends Error {}
class ToolCancelledError extends Error {}

function timeoutMessage(toolName: string, timeoutMs: number) {
  const message = `${toolName} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
  return ["start_target", "submit_flag"].includes(toolName)
    ? `${message} The remote outcome may be unknown; inspect current state before retrying.`
    : message
}

export function manageAgentTools(
  db: Database,
  agentId: string,
  tools: AgentTool[],
  resolve: (toolName: string, args: unknown) => number = (name, args) =>
    resolveToolTimeoutMs(name, args, defaultSettings)
): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const id = crypto.randomUUID()
      const timeoutMs = resolve(tool.name, args)
      const started = performance.now()
      const createdAt = new Date().toISOString()
      db.insert(agentToolCalls)
        .values({
          id,
          agentId,
          toolCallId,
          toolName: tool.name,
          status: "running",
          timeoutMs,
          createdAt,
        })
        .run()

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
        const details = resultDetails(result.details)
        db.update(agentToolCalls)
          .set({
            status: "succeeded" satisfies ToolStatus,
            succeeded: true,
            durationMs: Math.round(performance.now() - started),
            outputBytes: details.outputBytes ?? resultBytes(result.content),
            truncated: details.truncated,
            exitCode: details.exitCode ?? null,
            completedAt: new Date().toISOString(),
          })
          .where(eq(agentToolCalls.id, id))
          .run()
        return result
      } catch (rawError) {
        const cause = controller.signal.aborted
          ? controller.signal.reason
          : rawError
        const status: ToolStatus =
          cause instanceof ToolTimeoutError
            ? "timed_out"
            : cause instanceof ToolCancelledError
              ? "cancelled"
              : "failed"
        const error = cause instanceof Error ? cause.message : String(cause)
        db.update(agentToolCalls)
          .set({
            status,
            succeeded: false,
            durationMs: Math.round(performance.now() - started),
            error,
            completedAt: new Date().toISOString(),
          })
          .where(eq(agentToolCalls.id, id))
          .run()
        throw cause
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", cancel)
      }
    },
  }))
}
