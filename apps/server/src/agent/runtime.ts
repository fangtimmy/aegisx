import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core"
import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai"
import { isRetryableAssistantError } from "@earendil-works/pi-ai"
import { eq } from "drizzle-orm"
import type { LiveEvent, Message } from "../../../shared"
import type { createDatabase } from "../db"
import { agents, agentUsage } from "../db/schema"
import { redactSecrets } from "../infrastructure/redaction"
import type { DispatchKind } from "../run/types"
import { maybeCompact } from "./compact"
import {
  assistantUsage,
  fromAgentMessage,
  toAgentMessages,
  toLlmMessages,
} from "./convert"
import {
  clearToolTerminals,
  createToolTimeoutResolver,
  getToolTerminal,
  manageAgentTools,
} from "./managed-tools"

type Database = ReturnType<typeof createDatabase>["db"]

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

export type AgentActivity = "retrying" | "compacting" | null

export type RuntimeCallbacks = {
  onLiveEvent(event: LiveEvent): void
  onSettled(outcome: RuntimeOutcome): void | Promise<void>
  canRunTool?(): boolean
  /** Persist a committed message; returns stored message with seq. */
  commitMessage(message: Omit<Message, "seq"> & { seq?: number }): Message
  loadMessages(): Message[]
  getContext(): { summary: string | null; through: number }
  setContext(summary: string, through: number): void
  recordUsage(kind: string, usage: Record<string, unknown>): void
}

export type CreateRuntimeOptions = {
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
  getToolTimeoutSettings?: () => {
    defaultToolTimeoutMs: number
    toolTimeouts: Record<string, number>
  }
  callbacks: RuntimeCallbacks
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

function userAgentMessage(text: string, timestamp = Date.now()): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp,
  } as AgentMessage
}

/**
 * pi-agent loop for one agent. Does not know Run status machine.
 * Commits assistant/toolResult via callbacks; user/notice already in DB.
 */
export function createAgentRuntime(options: CreateRuntimeOptions) {
  const secrets = new Set(options.secrets)
  let phase: "idle" | "prompting" | "aborting" | "disposed" = "idle"
  const messageRevisions = new Map<string, number>()
  const toolRevisions = new Map<string, number>()
  let activeMessageId: string | undefined

  const nextRevision = (map: Map<string, number>, id: string) => {
    const revision = (map.get(id) ?? -1) + 1
    map.set(id, revision)
    return revision
  }

  const history = toAgentMessages(options.callbacks.loadMessages())

  async function transformContext(
    allMessages: AgentMessage[],
    signal?: AbortSignal
  ) {
    const ctx = options.callbacks.getContext()
    const result = await maybeCompact({
      model: options.model,
      models: options.models,
      messages: allMessages,
      contextSummary: ctx.summary,
      contextThrough: ctx.through,
      signal,
      onActivity: (active) => {
        options.callbacks.onLiveEvent({
          type: "agent.activity",
          agentId: options.agentId,
          activity: active ? "compacting" : null,
        })
      },
    })
    if (!result) return allMessages
    if (result.compact) {
      options.callbacks.setContext(
        result.compact.summary,
        result.compact.through
      )
      if (result.compact.usage) {
        options.callbacks.recordUsage("compaction", result.compact.usage)
      }
    }
    return result.effective
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: manageAgentTools(
        options.agentId,
        options.tools,
        options.getToolTimeoutSettings
          ? createToolTimeoutResolver(options.getToolTimeoutSettings)
          : undefined
      ),
      messages: history,
      thinkingLevel: options.thinkingLevel,
    },
    sessionId: options.agentId,
    streamFn: (model, context, streamOptions) =>
      options.models.streamSimple(model, context, streamOptions),
    convertToLlm: toLlmMessages,
    transformContext,
    beforeToolCall: async () => {
      if (options.callbacks.canRunTool?.() === false) {
        return {
          block: true,
          reason: "Run state no longer allows tool execution",
        }
      }
      return undefined
    },
    afterToolCall: async (context) => {
      const failed = context.isError
      if (!failed && options.callbacks.canRunTool?.() !== false)
        return undefined
      return {
        ...(failed ? { isError: true } : {}),
        ...(options.callbacks.canRunTool?.() === false
          ? { terminate: true }
          : {}),
      }
    },
    steeringMode: "all",
    followUpMode: "all",
    toolExecution: "parallel",
  })

  const unsubscribe = agent.subscribe((event) => {
    redactSecrets(event, secrets)
    handleEvent(event)
  })

  function progressMessageId(event: AgentEvent): string | undefined {
    if (event.type === "message_start") {
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
          : activeMessageId
      if (event.message.role === "assistant") activeMessageId = undefined
      return messageId
    }
    return undefined
  }

  function handleEvent(event: AgentEvent) {
    const messageId = progressMessageId(event)

    if (
      messageId &&
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end")
    ) {
      const revision = nextRevision(messageRevisions, messageId)
      if (event.type === "message_end") {
        // Only persist assistant + toolResult; user/notice already committed by service.
        // Reuse the progress messageId so clients can replace the live bubble in place.
        if (
          event.message.role === "assistant" ||
          event.message.role === "toolResult"
        ) {
          const createdAt = new Date().toISOString()
          const stored = options.callbacks.commitMessage(
            fromAgentMessage(event.message, {
              id: messageId,
              agentId: options.agentId,
              seq: 0,
              createdAt,
            })
          )
          const usage = assistantUsage(event.message)
          if (usage) options.callbacks.recordUsage("message", usage)
          options.callbacks.onLiveEvent({
            type: "message.committed",
            agentId: options.agentId,
            message: stored,
          })
          return
        }
      }
      options.callbacks.onLiveEvent({
        type: "message.progress",
        agentId: options.agentId,
        messageId,
        revision,
        message: fromAgentMessage(event.message, {
          id: messageId,
          agentId: options.agentId,
          seq: 0,
          createdAt: new Date().toISOString(),
        }),
      })
      return
    }

    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      const revision = nextRevision(toolRevisions, event.toolCallId)
      const ended = event.type === "tool_execution_end"
      const args = "args" in event ? event.args : undefined
      const terminal = ended
        ? getToolTerminal(options.agentId, event.toolCallId)
        : undefined
      options.callbacks.onLiveEvent({
        type: "tool.progress",
        agentId: options.agentId,
        toolCallId: event.toolCallId,
        revision,
        toolName: event.toolName,
        args,
        ...(event.type === "tool_execution_update"
          ? { result: event.partialResult }
          : event.type === "tool_execution_end"
            ? { result: event.result }
            : {}),
        status: ended ? (event.isError ? "error" : "done") : "running",
        ...(ended && event.isError ? { isError: true } : {}),
        ...(terminal?.terminal
          ? {
              terminal: terminal.terminal,
              ...(terminal.terminalMessage
                ? { terminalMessage: terminal.terminalMessage }
                : {}),
            }
          : {}),
      })
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
      options.callbacks.onLiveEvent({
        type: "agent.activity",
        agentId: options.agentId,
        activity: "retrying",
        detail: `attempt ${attempts} of ${cfg.maxAttempts}`,
      })
      await Bun.sleep(delay)
      if (stopped()) break
      try {
        await agent.continue()
      } catch {
        break
      }
      outcome = classify()
    }
    if (attempts > 0) {
      options.callbacks.onLiveEvent({
        type: "agent.activity",
        agentId: options.agentId,
        activity: null,
      })
    }
    return attempts > 0 ? { ...outcome, retries: attempts } : outcome
  }

  function startTurn(text: string) {
    if (phase === "disposed") throw new Error("Agent runtime is disposed")
    const msg = userAgentMessage(text)
    if (phase !== "idle") {
      agent.steer(msg)
      return
    }
    phase = "prompting"
    void agent
      .prompt(msg)
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
        phase = "idle"
        if (outcome.error) {
          outcome = {
            ...outcome,
            error: redactSecrets(outcome.error, secrets),
          }
        }
        if (outcome.summary) {
          outcome = {
            ...outcome,
            summary: redactSecrets(outcome.summary, secrets),
          }
        }
        await options.callbacks.onSettled(outcome)
      })
      .catch((error) => {
        console.error("Agent settlement failed", error)
      })
  }

  return {
    agent,
    dispatch(kind: DispatchKind, text: string) {
      void kind
      startTurn(text)
    },
    addSecrets(values: Iterable<string>) {
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
      clearToolTerminals(options.agentId)
    },
    get phase() {
      return phase
    },
  }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>
export type { AgentEvent }

/** Helpers used by session when wiring store. */
export function createRuntimePersistence(options: {
  db: Database
  agentId: string
  commitMessage: (message: Message) => Message
  loadMessages: () => Message[]
}) {
  return {
    commitMessage: (message: Omit<Message, "seq"> & { seq?: number }) => {
      const full = { ...message, seq: message.seq ?? 0 } as Message
      return options.commitMessage(full)
    },
    loadMessages: options.loadMessages,
    getContext: () => {
      const row = options.db
        .select({
          summary: agents.contextSummary,
          through: agents.contextThroughSeq,
        })
        .from(agents)
        .where(eq(agents.id, options.agentId))
        .get()
      return {
        summary: row?.summary ?? null,
        through: row?.through ?? 0,
      }
    },
    setContext: (summary: string, through: number) => {
      options.db
        .update(agents)
        .set({
          contextSummary: summary,
          contextThroughSeq: through,
        })
        .where(eq(agents.id, options.agentId))
        .run()
    },
    recordUsage: (kind: string, usage: Record<string, unknown>) => {
      options.db
        .insert(agentUsage)
        .values({
          id: crypto.randomUUID(),
          agentId: options.agentId,
          kind,
          usage: JSON.stringify(usage),
          createdAt: new Date().toISOString(),
        })
        .run()
    },
  }
}
