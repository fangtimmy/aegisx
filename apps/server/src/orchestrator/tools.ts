import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

/** Digest of a challenge for the list_challenges tool. */
export type ChallengeDigest = {
  id: string
  name: string
  category: string | null
  points: number | null
  targetCapable: boolean
  remoteSolved: boolean
  hasRunningRun: boolean
  lastRunStatus: string | null
  attempts: number
}

/** Digest of a run for get_status / start_run feedback. */
export type RunDigest = {
  id: string
  challengeId: string
  challengeName: string
  status: string
  source: string
  hasFlag: boolean
  createdAt: string
  updatedAt: string
}

/** read_run entry: role + flattened text (assistant text / tool summary). */
export type ReadRunItem = { seq: number; role: string; text: string }

export type ReadRunResult = {
  runId: string
  items: ReadRunItem[]
  nextAfter: number | null
}

/** Callbacks the orchestrator tools delegate to (wired by the service). A
 * rejection (guardrail / not-found) is returned as { reason }, not thrown, so
 * the orchestrator (an LLM) can adjust its plan. */
export type OrchestratorToolContext = {
  eventId: string
  listChallenges(): ChallengeDigest[]
  startRun(input: {
    challengeId: string
    initialPromptOverride?: string
    timeoutMs?: number
    modelId?: string
  }): Promise<{ runId: string; status: string; reason?: string }>
  stopRun(runId: string): Promise<{ status: string; reason?: string }>
  readRun(
    runId: string,
    opts?: { roles?: string[]; since?: number }
  ): Promise<ReadRunResult & { reason?: string }>
  getStatus(): {
    running: number
    maxConcurrentRuns: number
    inflightTargets: number
    maxConcurrentTargets: number
    runs: RunDigest[]
  }
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} }
}

/** The orchestrator's management tool set. File tools (read/bash/edit/write/
 * grep/find/ls) are enabled separately via the SDK builtin tool list and are
 * not defined here — they let the orchestrator keep strategy/state notes. */
export function createOrchestratorTools(ctx: OrchestratorToolContext) {
  return [
    defineTool({
      name: "list_challenges",
      label: "List challenges",
      description:
        "List all challenges in this event with points, target capability, solved state, and current run activity. Use this to decide what to work on next.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async () => {
        const list = ctx.listChallenges()
        if (list.length === 0) return textResult("No challenges in this event.")
        const lines = list.map((c) =>
          [
            `- ${c.name} (${c.id})`,
            `pts=${c.points ?? "?"}`,
            `cat=${c.category ?? "?"}`,
            `target=${c.targetCapable ? "yes" : "no"}`,
            `solved=${c.remoteSolved ? "yes" : "no"}`,
            `running=${c.hasRunningRun ? "yes" : "no"}`,
            `attempts=${c.attempts}`,
            c.lastRunStatus ? `last=${c.lastRunStatus}` : "",
          ]
            .filter(Boolean)
            .join(" | ")
        )
        return textResult(lines.join("\n"), { challenges: list })
      },
    }),
    defineTool({
      name: "start_run",
      label: "Start run",
      description:
        "Start a solver run for a challenge. The server enforces hard guardrails (global concurrency, target slots, no duplicate run on a challenge); a rejection comes back as a reason, not an error — adjust your plan accordingly. You may override the initial prompt and timeout per run.",
      parameters: Type.Object({
        challengeId: Type.String({ minLength: 1 }),
        initialPromptOverride: Type.Optional(
          Type.String({ maxLength: 50_000 })
        ),
        timeoutMs: Type.Optional(
          Type.Integer({ minimum: 60_000, maximum: 86_400_000 })
        ),
        modelId: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await ctx.startRun({
          challengeId: params.challengeId,
          ...(params.initialPromptOverride !== undefined
            ? { initialPromptOverride: params.initialPromptOverride }
            : {}),
          ...(params.timeoutMs !== undefined
            ? { timeoutMs: params.timeoutMs }
            : {}),
          ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
        })
        if (result.reason)
          return textResult(`Could not start run: ${result.reason}`)
        return textResult(
          `Started run ${result.runId} (status: ${result.status}). It will run autonomously; you will be notified when it goes idle, finishes, or hits its time limit.`,
          result
        )
      },
    }),
    defineTool({
      name: "stop_run",
      label: "Stop run",
      description:
        "Abort a run's current turn (like pressing Esc). The run goes idle with its container kept; use this to cut a stuck or off-track run before restarting it with a new strategy via start_run.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await ctx.stopRun(params.runId)
        if (result.reason)
          return textResult(`Could not stop run: ${result.reason}`)
        return textResult(
          `Stopped run ${params.runId} (status: ${result.status}).`,
          result
        )
      },
    }),
    defineTool({
      name: "read_run",
      label: "Read run",
      description:
        "Read a run's committed session entries to review its progress and reasoning. Returns assistant messages by default (tool calls summarized) to save your context; pass roles to include others. Use since for incremental reads on long runs.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
        roles: Type.Optional(Type.Array(Type.String())),
        since: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await ctx.readRun(params.runId, {
          ...(params.roles !== undefined ? { roles: params.roles } : {}),
          ...(params.since !== undefined ? { since: params.since } : {}),
        })
        if (result.reason)
          return textResult(`Could not read run: ${result.reason}`)
        const body =
          result.items.length > 0
            ? result.items
                .map((it) => `[${it.seq}] ${it.role}: ${it.text}`)
                .join("\n\n")
            : "(no matching entries yet)"
        return textResult(
          `${result.runId} (${result.items.length} entries, nextAfter=${result.nextAfter}):\n\n${body}`,
          result
        )
      },
    }),
    defineTool({
      name: "get_status",
      label: "Get status",
      description:
        "Snapshot of current concurrency/target slot usage and active runs. Call before planning the next start_run.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async () => {
        const s = ctx.getStatus()
        const lines = [
          `Concurrency: ${s.running}/${s.maxConcurrentRuns} runs`,
          `Target slots: ${s.inflightTargets}/${s.maxConcurrentTargets}`,
          "",
          "Active runs:",
          ...(s.runs.length > 0
            ? s.runs.map(
                (r) =>
                  `- ${r.challengeName} (${r.id}) | ${r.status} | src=${r.source} | flag=${r.hasFlag}`
              )
            : ["(none)"]),
        ]
        return textResult(lines.join("\n"), s)
      },
    }),
  ]
}

/** Flatten a SessionEntry's message content to compact text for read_run. */
export function flattenEntryText(entry: {
  type: string
  message?: {
    role: string
    content: unknown
  }
}): { role: string; text: string } | null {
  if (entry.type !== "message" || !entry.message) return null
  const content = entry.message.content
  const parts: string[] = []
  if (typeof content === "string") {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block)
      } else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string; name?: string }
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text)
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          parts.push(`[tool: ${b.name}]`)
        }
      }
    }
  }
  return {
    role: entry.message.role,
    text: parts.join("\n").trim() || "(empty)",
  }
}
