import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentToolResult,
} from "@earendil-works/pi-agent-core"
import type {
  Api,
  Message,
  Model,
  Models,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai"
import { isRetryableAssistantError } from "@earendil-works/pi-ai"
import { and, asc, eq, isNull, max } from "drizzle-orm"
import type { createDatabase } from "../db"
import {
  agentInbox,
  agentMessages,
  agentToolCalls,
  agentUsage,
  runAgents,
  runEvents,
} from "../db/schema"
import { redactSecrets } from "../infrastructure/redaction"
import {
  type AegisXMessage,
  type AegisXMetadata,
  type InboxKind,
  parseAgentMessage,
  parseInboxMetadata,
} from "./messages"

type Database = ReturnType<typeof createDatabase>["db"]

export type { AegisXMessage, AegisXMetadata, InboxKind } from "./messages"

export type RuntimeOutcome = {
  status: "success" | "error" | "aborted"
  summary: string | null
  error: string | null
  retries?: number
}

export type RetryConfig = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

type RuntimeOptions = {
  db: Database
  runId: string
  agentId: string
  systemPrompt: string
  model: Model<Api>
  models: Models
  tools: AgentTool[]
  secrets: Iterable<string>
  thinkingLevel: ModelThinkingLevel
  retryConfig?: RetryConfig
  canRunTool?(): boolean
  onEvent(event: AgentEvent, messageId?: string, cursor?: number): void
  onSettled(outcome: RuntimeOutcome): void | Promise<void>
}

function toLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) =>
    message.role === "aegisx"
      ? [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: message.text }],
            timestamp: message.timestamp,
          },
        ]
      : [message]
  ) as Message[]
}

export function publicAgentMessage(message: AgentMessage): AgentMessage {
  return message.role === "aegisx"
    ? ({
        role: "user",
        content: [{ type: "text", text: message.text }],
        timestamp: message.timestamp,
        aegisx: {
          id: message.id,
          kind: message.kind,
          ...(message.metadata ? { metadata: message.metadata } : {}),
        },
      } as AgentMessage)
    : message
}

function publicEvent(event: AgentEvent): AgentEvent {
  if (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  ) {
    return { ...event, message: publicAgentMessage(event.message) }
  }
  if (event.type === "agent_end") {
    return { ...event, messages: event.messages.map(publicAgentMessage) }
  }
  return event
}

function lastAssistant(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "assistant") return message
  }
  return undefined
}

function assistantText(message: AgentMessage | undefined) {
  if (message?.role !== "assistant") return null
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
  return text ? text.slice(0, 50_000) : null
}

function textMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }
}

function contextSize(messages: AgentMessage[]) {
  return JSON.stringify(messages).length
}

function toolResultBytes(content: AgentToolResult<unknown>["content"]) {
  return content.reduce(
    (total, part) =>
      total +
      (part.type === "text"
        ? Buffer.byteLength(part.text)
        : Buffer.byteLength(part.data, "base64")),
    0
  )
}

function toolMetricDetails(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
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

export function createAgentRuntime(options: RuntimeOptions) {
  const rows = options.db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.agentId, options.agentId))
    .orderBy(asc(agentMessages.sequence))
    .all()
  const messages = rows.map((row) => parseAgentMessage(row.message))
  let sequence =
    options.db
      .select({ value: max(agentMessages.sequence) })
      .from(agentMessages)
      .where(eq(agentMessages.agentId, options.agentId))
      .get()?.value ?? 0
  let phase: "idle" | "prompting" | "aborting" | "disposed" = "idle"
  const queued = new Set<string>()
  const secrets = new Set(options.secrets)
  const startedToolCalls = new Map<string, number>()
  let contextSummary = options.db
    .select({
      summary: runAgents.contextSummary,
      through: runAgents.contextThroughSequence,
    })
    .from(runAgents)
    .where(eq(runAgents.id, options.agentId))
    .get()
  const summaryMessage = (summary: string): AgentMessage =>
    textMessage(`Previous conversation summary:\n\n${summary}`) as AgentMessage

  async function transformContext(
    allMessages: AgentMessage[],
    signal?: AbortSignal
  ) {
    const through = Math.min(contextSummary?.through ?? 0, allMessages.length)
    const tail = allMessages.slice(through)
    const effective = contextSummary?.summary
      ? [summaryMessage(contextSummary.summary), ...tail]
      : tail
    const threshold = options.model.contextWindow * 3
    if (contextSize(effective) < threshold) return effective

    let keptSize = 0
    let keepAt = tail.length
    const keepBudget = options.model.contextWindow
    while (keepAt > 0 && keptSize < keepBudget) {
      keepAt -= 1
      keptSize += contextSize([tail[keepAt]])
    }
    while (
      keepAt < tail.length &&
      tail[keepAt]?.role !== "user" &&
      tail[keepAt]?.role !== "aegisx"
    ) {
      keepAt += 1
    }
    if (keepAt === 0 || keepAt === tail.length) return effective

    const compacted = [
      ...(contextSummary?.summary
        ? [summaryMessage(contextSummary.summary)]
        : []),
      ...tail.slice(0, keepAt),
    ]
    const response = await options.models.completeSimple(
      options.model,
      {
        systemPrompt:
          "Summarize the conversation for another agent. Preserve concrete findings, commands, files, failures, pending work, and constraints. Do not continue the task.",
        messages: [textMessage(JSON.stringify(toLlm(compacted)))],
      },
      { signal, maxTokens: 4096 }
    )
    options.db
      .insert(agentUsage)
      .values({
        id: crypto.randomUUID(),
        agentId: options.agentId,
        kind: "compaction",
        usage: JSON.stringify(response.usage),
        createdAt: new Date().toISOString(),
      })
      .run()
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return effective
    }
    const summary = response.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
    if (!summary) return effective

    contextSummary = { summary, through: through + keepAt }
    options.db
      .update(runAgents)
      .set({
        contextSummary: summary,
        contextThroughSequence: through + keepAt,
      })
      .where(eq(runAgents.id, options.agentId))
      .run()
    return [summaryMessage(summary), ...tail.slice(keepAt)]
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools,
      messages,
      thinkingLevel: options.thinkingLevel,
    },
    sessionId: options.agentId,
    streamFn: (model, context, streamOptions) =>
      options.models.streamSimple(model, context, streamOptions),
    convertToLlm: toLlm,
    transformContext,
    beforeToolCall: async (context) => {
      if (options.canRunTool?.() === false) {
        return {
          block: true,
          reason: "Run state no longer allows tool execution",
        }
      }
      startedToolCalls.set(context.toolCall.id, performance.now())
      return undefined
    },
    afterToolCall: async (context) => {
      const startedAt = startedToolCalls.get(context.toolCall.id)
      startedToolCalls.delete(context.toolCall.id)
      const details = toolMetricDetails(context.result.details)
      const failed = context.isError
      if (startedAt !== undefined) {
        options.db
          .insert(agentToolCalls)
          .values({
            id: crypto.randomUUID(),
            agentId: options.agentId,
            toolCallId: context.toolCall.id,
            toolName: context.toolCall.name,
            durationMs: Math.round(performance.now() - startedAt),
            outputBytes:
              details.outputBytes ?? toolResultBytes(context.result.content),
            truncated: details.truncated,
            succeeded: !failed,
            exitCode: details.exitCode ?? null,
            createdAt: new Date().toISOString(),
          })
          .run()
      }
      if (!failed && options.canRunTool?.() !== false) return undefined
      return {
        ...(failed ? { isError: true } : {}),
        ...(options.canRunTool?.() === false ? { terminate: true } : {}),
      }
    },
    steeringMode: "all",
    followUpMode: "all",
    toolExecution: "parallel",
  })

  let activeMessageId: string | undefined
  const messageIdForEvent = (event: AgentEvent) => {
    if (event.type === "message_start") {
      if (event.message.role === "aegisx") return event.message.id
      if (event.message.role === "toolResult") {
        return `tool:${event.message.toolCallId}`
      }
      activeMessageId = crypto.randomUUID()
      return activeMessageId
    }
    if (event.type === "message_update") return activeMessageId
    if (event.type === "message_end") {
      const messageId =
        event.message.role === "toolResult"
          ? `tool:${event.message.toolCallId}`
          : event.message.role === "aegisx"
            ? event.message.id
            : activeMessageId
      if (event.message.role === "assistant") activeMessageId = undefined
      return messageId
    }
    return undefined
  }

  const unsubscribe = agent.subscribe((event) => {
    redactSecrets(event, secrets)
    const runtimeId = messageIdForEvent(event)
    let cursor: number | undefined
    if (event.type === "message_end") {
      sequence += 1
      options.db.transaction((tx) => {
        const messageId = crypto.randomUUID()
        const createdAt = new Date().toISOString()
        tx.insert(agentMessages)
          .values({
            id: messageId,
            agentId: options.agentId,
            sequence,
            runtimeId: runtimeId ?? crypto.randomUUID(),
            message: JSON.stringify(event.message),
            createdAt,
          })
          .run()
        cursor = tx
          .insert(runEvents)
          .values({
            runId: options.runId,
            type: "message_committed",
            agentId: options.agentId,
            entityId: messageId,
            createdAt,
          })
          .returning({ id: runEvents.id })
          .get()?.id
        if (event.message.role === "aegisx") {
          tx.update(agentInbox)
            .set({ deliveredAt: new Date().toISOString() })
            .where(eq(agentInbox.id, event.message.id))
            .run()
          queued.delete(event.message.id)
        }
      })
    }
    options.onEvent(publicEvent(event), runtimeId, cursor)
  })

  function pending() {
    return options.db
      .select()
      .from(agentInbox)
      .where(
        and(
          eq(agentInbox.agentId, options.agentId),
          isNull(agentInbox.deliveredAt)
        )
      )
      .orderBy(asc(agentInbox.createdAt), asc(agentInbox.id))
      .all()
  }

  function message(row: ReturnType<typeof pending>[number]): AegisXMessage {
    const metadata = row.metadata ? parseInboxMetadata(row.metadata) : undefined
    return {
      role: "aegisx",
      id: row.id,
      kind: row.kind as InboxKind,
      text: row.content,
      timestamp: Date.parse(row.createdAt),
      ...(metadata ? { metadata } : {}),
    }
  }

  function classify(): RuntimeOutcome {
    const final = lastAssistant(agent.state.messages)
    if (final?.role === "assistant" && final.stopReason === "error") {
      return {
        status: "error",
        summary: assistantText(final),
        error: final.errorMessage ?? "Agent request failed",
      }
    }
    if (final?.role === "assistant" && final.stopReason === "aborted") {
      return {
        status: "aborted",
        summary: assistantText(final),
        error: final.errorMessage ?? null,
      }
    }
    return { status: "success", summary: assistantText(final), error: null }
  }

  async function retryAfterError(
    initial: RuntimeOutcome
  ): Promise<RuntimeOutcome> {
    const cfg = options.retryConfig ?? {
      maxAttempts: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    }
    let outcome = initial
    let attempts = 0
    const stopped = () => phase === "disposed" || phase === "aborting"
    while (
      outcome.status === "error" &&
      attempts < cfg.maxAttempts &&
      !stopped()
    ) {
      const messages = agent.state.messages
      const last = messages[messages.length - 1]
      if (last?.role !== "assistant" || !isRetryableAssistantError(last)) {
        break
      }
      agent.state.messages = messages.slice(0, -1)
      attempts += 1
      const delay = Math.min(
        cfg.baseDelayMs * 2 ** (attempts - 1),
        cfg.maxDelayMs
      )
      await Bun.sleep(delay)
      if (stopped()) break
      try {
        await agent.continue()
      } catch {
        break
      }
      outcome = classify()
    }
    return attempts > 0 ? { ...outcome, retries: attempts } : outcome
  }

  function start(first: AegisXMessage) {
    if (phase !== "idle") {
      agent.steer(first)
      return
    }
    phase = "prompting"
    const prompting = agent.prompt(first)
    for (const row of pending()) {
      if (row.id !== first.id && !queued.has(row.id)) {
        queued.add(row.id)
        agent.steer(message(row))
      }
    }
    void prompting
      .then(
        () => classify(),
        (error): RuntimeOutcome => ({
          status: "error",
          summary: null,
          error:
            error instanceof Error ? error.message : "Agent runtime failed",
        })
      )
      .then((outcome) => retryAfterError(outcome))
      .then(async (outcome) => {
        if (phase === "disposed") return
        queued.clear()
        phase = "idle"
        await options.onSettled(outcome)
      })
      .catch((error) => {
        console.error("Agent settlement failed", error)
      })
  }

  function replayPending() {
    const rows = pending().filter((row) => !queued.has(row.id))
    if (rows.length === 0) return
    queued.add(rows[0].id)
    start(message(rows[0]))
  }

  function dispatch(
    kind: InboxKind,
    content: string,
    metadata?: AegisXMetadata,
    requestedId?: string
  ) {
    if (phase === "disposed") throw new Error("Agent runtime is disposed")
    const id = requestedId ?? crypto.randomUUID()
    if (requestedId) {
      const existing = options.db
        .select()
        .from(agentInbox)
        .where(eq(agentInbox.id, requestedId))
        .get()
      if (existing) {
        const storedMetadata = existing.metadata ?? null
        const requestedMetadata = metadata ? JSON.stringify(metadata) : null
        if (
          existing.agentId !== options.agentId ||
          existing.kind !== kind ||
          existing.content !== content ||
          storedMetadata !== requestedMetadata
        ) {
          throw new Error("Message ID conflicts with an existing message")
        }
        return requestedId
      }
    }
    const createdAt = new Date().toISOString()
    options.db
      .insert(agentInbox)
      .values({
        id,
        agentId: options.agentId,
        kind,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
        createdAt,
      })
      .run()
    queued.add(id)
    start({
      role: "aegisx",
      id,
      kind,
      text: content,
      timestamp: Date.parse(createdAt),
      ...(metadata ? { metadata } : {}),
    })
    return id
  }

  return {
    agent,
    dispatch,
    replayPending,
    addSecrets: (values: Iterable<string>) => {
      for (const value of values) secrets.add(value)
    },
    abort: async () => {
      if (phase === "disposed") return
      phase = "aborting"
      agent.clearAllQueues()
      agent.abort()
      await agent.waitForIdle()
      if (phase === "aborting") phase = "idle"
    },
    dispose: () => {
      if (phase === "disposed") return
      phase = "disposed"
      unsubscribe()
      agent.abort()
      agent.clearAllQueues()
    },
    get phase() {
      return phase
    },
  }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>
export type { AgentEvent }
