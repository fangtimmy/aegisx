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
  /** Hard deadline (ISO) the run will be aborted at; null if untimed. */
  deadlineAt: string | null
}

/** A run row for the list_runs tool (incl. closed/history). Surfaces the
 * outcome (summary + flag) and timing the active-only RunDigest omits, so the
 * orchestrator can review what has already been tried on a challenge. */
export type RunListItem = {
  id: string
  challengeId: string
  challengeName: string
  status: string
  source: string
  hasFlag: boolean
  summary: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  deadlineAt: string | null
}

/** Full challenge detail for the get_challenge tool. Adds the description,
 * attachments, target connectivity, platform/solved state, and run-activity
 * breakdown that the list digest omits — everything the orchestrator needs to
 * judge a challenge and write a targeted initial prompt before starting. */
export type ChallengeDetail = ChallengeDigest & {
  description: string
  platformIntegrated: boolean
  available: boolean
  attachments: { name: string; size: number }[]
  /** Parsed target_info: per-target name + exposed services (host:port etc). */
  targets: { name: string; services: string[] }[]
  runningRuns: number
  idleRuns: number
  closedRuns: number
  lastRunSummary: string | null
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
  getChallenge(challengeId: string): ChallengeDetail | { reason: string }
  listRuns(opts?: {
    challengeId?: string
    status?: "running" | "idle" | "closed"
  }): RunListItem[]
  startRun(input: {
    challengeId: string
    initialPromptOverride?: string
    timeoutMs?: number
    modelId?: string
  }): Promise<{ runId: string; status: string; reason?: string }>
  stopRun(runId: string): Promise<{ status: string; reason?: string }>
  messageRun(
    runId: string,
    input: { text: string; deliverAs?: "steer" | "followUp" }
  ): Promise<{ status: string; reason?: string }>
  closeRun(runId: string): Promise<{ status: string; reason?: string }>
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
        "Start a solver run for a challenge. The server enforces hard guardrails (global run concurrency; distinct target-capable challenges ≤ target slots); a rejection comes back as a reason, not an error — adjust your plan accordingly. Multiple runs on the same challenge are allowed. You may override the initial prompt and timeout per run.",
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
        "Abort a run's current turn (like pressing Esc). The run goes idle with its container kept. Use to cut a stuck or off-track turn; then either message_run to redirect it in place, or close_run to release it.",
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
        "Read a run's committed session entries to review its progress and reasoning. Returns assistant messages and tool results by default (thinking omitted; each item truncated) to save your context; pass roles to narrow or expand (e.g. ['assistant'] for reasoning only, ['user'] for the solver's prompts). Use since for incremental reads on long runs. Output is capped; if truncated, read again with a larger since cursor.",
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
        // Overall body cap so a long run can't blow the orchestrator's context.
        const lines: string[] = []
        let used = 0
        for (const it of result.items) {
          const line = `[${it.seq}] ${it.role}: ${it.text}`
          if (used + line.length + 2 > READ_RUN_TOTAL_CHAR_LIMIT) break
          lines.push(line)
          used += line.length + 2
        }
        const dropped = result.items.length - lines.length
        const body =
          lines.length > 0 ? lines.join("\n\n") : "(no matching entries yet)"
        const note =
          dropped > 0
            ? `\n\n… (${dropped} more entries omitted — read again with a larger since cursor)`
            : ""
        return textResult(
          `${result.runId} (${result.items.length} entries, nextAfter=${result.nextAfter}):\n\n${body}${note}`,
          { ...result, truncated: dropped > 0 }
        )
      },
    }),
    defineTool({
      name: "get_status",
      label: "Get status",
      description:
        "Snapshot of current concurrency / target-slot usage and active runs. Target slots count DISTINCT target-capable challenges under attack, not runs. Call before planning the next action.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async () => {
        const s = ctx.getStatus()
        const lines = [
          `Concurrency: ${s.running}/${s.maxConcurrentRuns} runs`,
          `Target slots: ${s.inflightTargets}/${s.maxConcurrentTargets} distinct challenges`,
          "",
          "Active runs:",
          ...(s.runs.length > 0
            ? s.runs.map((r) => {
                const base = `- ${r.challengeName} (${r.id}) | ${r.status} | src=${r.source} | flag=${r.hasFlag}`
                return r.deadlineAt
                  ? `${base} | deadline=${r.deadlineAt}`
                  : base
              })
            : ["(none)"]),
        ]
        return textResult(lines.join("\n"), s)
      },
    }),
    defineTool({
      name: "get_challenge",
      label: "Get challenge",
      description:
        "Full detail for one challenge: description, attachments (names/sizes), target connectivity (per-target name + exposed services), solved/available state, and a run-activity breakdown (running/idle/closed counts, last run summary). Read this before starting a challenge you don't know, or when judging difficulty / writing a targeted initial prompt.",
      parameters: Type.Object({
        challengeId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const c = ctx.getChallenge(params.challengeId)
        if ("reason" in c)
          return textResult(`Could not read challenge: ${c.reason}`)
        const lines: string[] = [
          `${c.name} (${c.id})`,
          `pts=${c.points ?? "?"} | cat=${c.category ?? "?"} | target=${c.targetCapable ? "yes" : "no"} | solved=${c.remoteSolved ? "yes" : "no"} | available=${c.available ? "yes" : "no"}`,
          `runs: ${c.runningRuns} running / ${c.idleRuns} idle / ${c.closedRuns} closed (attempts=${c.attempts})`,
          c.lastRunSummary ? `last summary: ${c.lastRunSummary}` : "",
          "",
          c.description.trim() || "(no description)",
        ]
        if (c.attachments.length > 0) {
          lines.push(
            "",
            "Attachments:",
            ...c.attachments.map((a) => `- ${a.name} (${a.size} bytes)`)
          )
        }
        if (c.targets.length > 0) {
          lines.push(
            "",
            "Targets:",
            ...c.targets.map(
              (t) =>
                `- ${t.name}${t.services.length > 0 ? ` — ${t.services.join(", ")}` : ""}`
            )
          )
        }
        return textResult(lines.join("\n"), c)
      },
    }),
    defineTool({
      name: "list_runs",
      label: "List runs",
      description:
        "Enumerate runs (most recent first), optionally filtered by challenge or status. Each row carries its outcome (summary, flag, error) and timing. Use this to review what has been tried — find a run id here before read_run / message_run / close_run, and to avoid repeating failed strategies. Output is capped to the most recent runs.",
      parameters: Type.Object({
        challengeId: Type.Optional(Type.String({ minLength: 1 })),
        status: Type.Optional(
          Type.Union([
            Type.Literal("running"),
            Type.Literal("idle"),
            Type.Literal("closed"),
          ])
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const list = ctx.listRuns({
          ...(params.challengeId !== undefined
            ? { challengeId: params.challengeId }
            : {}),
          ...(params.status !== undefined ? { status: params.status } : {}),
        })
        if (list.length === 0) return textResult("No matching runs.")
        const lines = list.map((r) => {
          const parts = [
            `- ${r.challengeName} (${r.id})`,
            r.status,
            `src=${r.source}`,
            `flag=${r.hasFlag ? "yes" : "no"}`,
          ]
          if (r.summary) parts.push(`summary=${truncate(r.summary, 200)}`)
          if (r.error) parts.push(`err=${truncate(r.error, 200)}`)
          return parts.join(" | ")
        })
        return textResult(lines.join("\n"), { runs: list })
      },
    }),
    defineTool({
      name: "message_run",
      label: "Message run",
      description:
        "Send guidance to a run. On an idle or closed run this starts/continues a turn, keeping the solver's context and workspace (a closed run is cold-restored with a fresh container). On a running run, deliverAs steers ('steer', default — injected into the current turn) or queues ('followUp' — next turn). Prefer this over stop_run + start_run when the solver has useful context: redirect it instead of throwing its work away. Restoring a closed run respects the global run concurrency cap; a rejection comes back as a reason.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
        deliverAs: Type.Optional(
          Type.Union([Type.Literal("steer"), Type.Literal("followUp")])
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await ctx.messageRun(params.runId, {
          text: params.text,
          ...(params.deliverAs !== undefined
            ? { deliverAs: params.deliverAs }
            : {}),
        })
        if (result.reason)
          return textResult(`Could not message run: ${result.reason}`)
        return textResult(
          `Sent to run ${params.runId} (status: ${result.status}).`,
          result
        )
      },
    }),
    defineTool({
      name: "close_run",
      label: "Close run",
      description:
        "Release a run's container (→ closed). The run's session and history are kept, and it can be resumed later with message_run. Use to free resources on runs you are pausing or done actively working. No-op-style error if the run is already closed.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await ctx.closeRun(params.runId)
        if (result.reason)
          return textResult(`Could not close run: ${result.reason}`)
        return textResult(
          `Closed run ${params.runId} (status: ${result.status}); resume it later with message_run.`,
          result
        )
      },
    }),
  ]
}

/** Per-item character cap for read_run (bounds the orchestrator's context). */
export const READ_RUN_ITEM_CHAR_LIMIT = 1500
/** Total character cap for a read_run response body. */
export const READ_RUN_TOTAL_CHAR_LIMIT = 16_000
/** Cap on the number of rows list_runs returns (bounds context). */
export const LIST_RUNS_ROW_LIMIT = 50

function truncate(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}… (truncated at ${limit} chars)`
    : text
}

/**
 * Flatten a SessionEntry's message content to compact text for read_run.
 *
 * - assistant: visible text + `[tool: <name>]` per tool call. Thinking blocks
 *   are dropped — verbose and low-value for progress review.
 * - toolResult: `[result: <toolName>] <text>` — included so the orchestrator
 *   sees what a solver's tool calls actually returned, not just that they ran.
 * - user / other: their text, if any.
 *
 * Each item is truncated to {@link READ_RUN_ITEM_CHAR_LIMIT}; the read_run
 * tool applies a further total cap ({@link READ_RUN_TOTAL_CHAR_LIMIT}).
 */
export function flattenEntryText(entry: {
  type: string
  message?: {
    role: string
    content: unknown
    toolName?: string
  }
}): { role: string; text: string } | null {
  if (entry.type !== "message" || !entry.message) return null
  const msg = entry.message
  const content = msg.content
  const parts: string[] = []
  if (typeof content === "string") {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block)
      } else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string; name?: string }
        // Keep visible text; surface tool calls; skip thinking (verbose).
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text)
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          parts.push(`[tool: ${b.name}]`)
        }
      }
    }
  }
  let text = parts.join("\n").trim()
  if (msg.role === "toolResult") {
    text = `[result: ${msg.toolName ?? "tool"}] ${text || "(empty)"}`
  }
  if (!text) return null
  return { role: msg.role, text: truncate(text, READ_RUN_ITEM_CHAR_LIMIT) }
}
