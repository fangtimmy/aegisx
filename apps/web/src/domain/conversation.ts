import type {
  AssistantMessage,
  Message,
  NoticeMessage,
  ToolResultMessage,
  UserMessage,
} from "@/api"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function text(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncateLabel(value: string, limit = 100): string {
  const line = value.split("\n", 1)[0].trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** First-line `# comment` (not shebang) for bash tool titles. */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf("\n")
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith("#") || firstLine.startsWith("#!")) return undefined
  return firstLine.replace(/^#+\s*/, "") || undefined
}

/** Path from tool args (`filePath` preferred, legacy `path` fallback). */
export function toolFilePath(args: unknown): string {
  if (!isRecord(args)) return ""
  return text(args.filePath || args.path).trim()
}

export type ToolSubjectKind = "path" | "text"

export type ToolStatusParts = {
  verb: string
  subject: string
  subjectKind: ToolSubjectKind
}

const FILE_VERBS: Record<string, [running: string, done: string]> = {
  read: ["Reading", "Read"],
  write: ["Writing", "Wrote"],
  edit: ["Editing", "Edited"],
  ls: ["Listing", "Listed"],
  grep: ["Searching for", "Searched for"],
  find: ["Finding", "Found"],
}

const SIMPLE_VERBS: Record<string, [running: string, done: string]> = {
  submit_flag: ["Submitting flag", "Submitted flag"],
  finish_run: ["Finishing run", "Completed run"],
  spawn_agent: ["Spawning agent", "Started agent"],
  inspect_agent: ["Inspecting agent", "Inspected agent"],
  get_target: ["Checking target", "Checked target"],
  start_target: ["Starting target", "Started target"],
  extend_target: ["Extending target", "Extended target lifetime"],
  stop_target: ["Stopping target", "Stopped target"],
}

function pickVerb(
  table: Record<string, [string, string]>,
  name: string,
  running: boolean
) {
  const pair = table[name]
  if (!pair) return null
  return running ? pair[0] : pair[1]
}

export function toolStatusParts(
  name: string,
  args: unknown,
  running: boolean
): ToolStatusParts {
  const a = isRecord(args) ? args : null

  if (name === "bash") {
    const command = text(a?.command)
    const comment = extractBashCommentLabel(command)
    return {
      verb: a?.background
        ? running
          ? "Background"
          : "Backgrounded"
        : running
          ? "Running"
          : "Ran",
      subject: truncateLabel(comment ?? command, 80),
      subjectKind: "text",
    }
  }

  if (name === "read" || name === "write" || name === "edit" || name === "ls") {
    return {
      verb: pickVerb(FILE_VERBS, name, running) ?? name,
      subject: toolFilePath(a) || (name === "ls" ? text(a?.path).trim() : ""),
      subjectKind: "path",
    }
  }

  if (name === "grep" || name === "find") {
    const pattern = text(a?.pattern)
    return {
      verb: pickVerb(FILE_VERBS, name, running) ?? name,
      subject: pattern ? `“${pattern}”` : "",
      subjectKind: "text",
    }
  }

  if (name === "spawn_agent") {
    return {
      verb: pickVerb(SIMPLE_VERBS, name, running) ?? name,
      subject: truncateLabel(text(a?.name)),
      subjectKind: "text",
    }
  }

  return {
    verb:
      pickVerb(SIMPLE_VERBS, name, running) ??
      (running ? `Running ${name}` : name),
    subject: "",
    subjectKind: "text",
  }
}

export function toolStatusLabel(
  name: string,
  args: unknown,
  running: boolean
): string {
  const { verb, subject } = toolStatusParts(name, args, running)
  return subject ? `${verb} ${subject}` : verb
}

function handoffFromNotice(message: NoticeMessage) {
  if (!message.handoff) return null
  const marker = "\n\nFinal output:\n\n"
  return {
    agentId: message.handoff.agentId,
    agentName: message.handoff.agentName,
    status: message.handoff.status,
    body: message.text.includes(marker)
      ? message.text.slice(message.text.indexOf(marker) + marker.length)
      : message.text,
  }
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      message: Message
    }
  | {
      key: string
      type: "tool"
      toolCallId: string
      toolName: string
      args: unknown
      result?: unknown
      isError: boolean
      status: "running" | "done"
      terminal?: "timed_out" | "cancelled" | "failed"
      terminalMessage?: string
    }
  | {
      key: string
      type: "error"
      body: string
    }

export type ToolBlock = {
  key: string
  type: "tool"
  id: string
  name: string
  args: unknown
  output: string
  details?: unknown
  status: "pending" | "running" | "done" | "error"
  /** True while the LLM is still generating tool-call arguments (not yet executing). */
  streaming?: boolean
  terminal?: "timed_out" | "cancelled" | "failed"
  terminalMessage?: string
}

type AgentBlock =
  | { key: string; type: "text"; body: string; streaming?: boolean }
  | {
      key: string
      type: "reasoning"
      body: string
      durationMs?: number
    }
  | { key: string; type: "error"; body: string }
  | ToolBlock

export type ConversationItem =
  | {
      key: string
      type: "handoff"
      agentId: string
      agentName: string
      status: string
      body: string
      timestamp?: string | number
    }
  | {
      key: string
      type: "user"
      body: string
      timestamp?: string | number
    }
  | {
      key: string
      type: "agent"
      blocks: AgentBlock[]
      timestamp?: string | number
    }

function contentText(content: unknown) {
  const values = Array.isArray(content) ? content : [content]
  return values
    .flatMap((part) => {
      if (typeof part === "string") return part
      if (!isRecord(part)) return []
      if (part.type === "text") return text(part.text)
      if (part.type === "image") return `[Image: ${text(part.mimeType)}]`
      return []
    })
    .filter(Boolean)
    .join("\n")
}

function resultText(value: unknown) {
  if (isRecord(value) && "content" in value) {
    return contentText(value.content) || text(value)
  }
  return text(value)
}

function messageTimestamp(message: Message, fallback?: string | number) {
  return typeof message.timestamp === "number" ? message.timestamp : fallback
}

function messageDuration(message: Message, endedAt?: string | number) {
  if (typeof message.timestamp !== "number" || endedAt === undefined) {
    return undefined
  }
  const end =
    typeof endedAt === "number" ? endedAt : new Date(endedAt).getTime()
  const duration = end - message.timestamp
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function applyUser(
  message: UserMessage,
  items: ConversationItem[],
  fallback?: string | number,
  stableKey?: string
) {
  const body = contentText(message.content)
  if (!body) return
  const timestamp = messageTimestamp(message, fallback)
  items.push({
    key: stableKey ?? `user:${items.length}`,
    type: "user",
    body,
    timestamp,
  })
}

function applyNotice(
  message: NoticeMessage,
  items: ConversationItem[],
  fallback?: string | number,
  stableKey?: string
) {
  const timestamp = messageTimestamp(message, fallback)
  const handoff = handoffFromNotice(message)
  if (handoff) {
    items.push({
      key: stableKey ?? `handoff:${items.length}`,
      type: "handoff",
      agentName: handoff.agentName,
      agentId: handoff.agentId,
      status: handoff.status,
      body: handoff.body,
      timestamp,
    })
    return
  }
  if (!message.text.trim()) return
  items.push({
    key: stableKey ?? `notice:${items.length}`,
    type: "user",
    body: message.text,
    timestamp,
  })
}

function applyToolResult(
  message: ToolResultMessage,
  tools: Map<string, ToolBlock>,
  currentAgent: (
    timestamp?: string | number
  ) => Extract<ConversationItem, { type: "agent" }>,
  timestamp?: string | number
) {
  const id = message.toolCallId
  const existing = tools.get(id)
  const block =
    existing ??
    ({
      key: `tool:${id}`,
      type: "tool",
      id,
      name: message.toolName || "unknown",
      args: null,
      output: "",
      status: "pending",
    } satisfies ToolBlock)
  block.output = contentText(message.content) || resultText(message.details)
  if (message.details !== undefined) block.details = message.details
  block.status = message.isError ? "error" : "done"
  if (!existing) {
    currentAgent(timestamp).blocks.push(block)
    tools.set(id, block)
  }
}

function applyAssistant(
  message: AssistantMessage,
  tools: Map<string, ToolBlock>,
  currentAgent: (
    timestamp?: string | number
  ) => Extract<ConversationItem, { type: "agent" }>,
  itemsLength: number,
  fallback?: string | number,
  stableKey?: string,
  streaming = false
) {
  const timestamp = messageTimestamp(message, fallback)
  const blocks = currentAgent(timestamp).blocks
  const blockPrefix = stableKey ?? `message:${timestamp ?? itemsLength}`
  const durationMs = messageDuration(message, fallback)
  const content = Array.isArray(message.content)
    ? message.content
    : [message.content]
  let lastTextBlock: Extract<AgentBlock, { type: "text" }> | null = null
  let lastToolBlock: ToolBlock | null = null
  for (const [index, part] of content.entries()) {
    const key = `${blockPrefix}:${index}`
    if (typeof part === "string") {
      if (part.trim()) {
        const block = { key, type: "text" as const, body: part }
        blocks.push(block)
        lastTextBlock = block
      }
      continue
    }
    if (!isRecord(part)) continue
    if (part.type === "text") {
      const body = text(part.text)
      if (body.trim()) {
        const block = { key, type: "text" as const, body }
        blocks.push(block)
        lastTextBlock = block
      }
    } else if (part.type === "thinking") {
      const body = text(part.thinking)
      if (body.trim()) {
        blocks.push({ key, type: "reasoning", body, durationMs })
      }
    } else if (part.type === "toolCall") {
      const id = text(part.id)
      const block: ToolBlock = {
        key: `tool:${id}`,
        type: "tool",
        id,
        name: text(part.name) || "unknown",
        args: part.arguments,
        output: "",
        status: "pending",
      }
      blocks.push(block)
      tools.set(id, block)
      lastToolBlock = block
    }
  }
  if (streaming && lastTextBlock) lastTextBlock.streaming = true
  if (streaming && lastToolBlock) lastToolBlock.streaming = true
  if (message.stopReason === "error" && message.errorMessage) {
    blocks.push({
      key: `${blockPrefix}:error`,
      type: "error",
      body: text(message.errorMessage),
    })
  }
}

export function buildConversation(
  history: Message[],
  live: LiveEntry[]
): ConversationItem[] {
  const items: ConversationItem[] = []
  const tools = new Map<string, ToolBlock>()
  let agent: Extract<ConversationItem, { type: "agent" }> | null = null

  function currentAgent(timestamp?: string | number) {
    if (agent) return agent
    agent = {
      key: `agent:${items.length}:${timestamp ?? "live"}`,
      type: "agent",
      blocks: [],
      timestamp,
    }
    items.push(agent)
    return agent
  }

  function applyMessage(
    message: Message,
    fallback?: string | number,
    stableKey?: string,
    streaming = false
  ) {
    if (message.role === "user") {
      applyUser(message, items, fallback, stableKey)
      agent = null
      return
    }
    if (message.role === "notice") {
      applyNotice(message, items, fallback, stableKey)
      agent = null
      return
    }
    if (message.role === "toolResult") {
      applyToolResult(
        message,
        tools,
        currentAgent,
        messageTimestamp(message, fallback)
      )
      return
    }
    if (message.role === "assistant") {
      applyAssistant(
        message,
        tools,
        currentAgent,
        items.length,
        fallback,
        stableKey,
        streaming
      )
    }
  }

  for (const entry of history) {
    applyMessage(entry, entry.createdAt, entry.id)
  }

  for (const entry of live) {
    if (entry.type === "message") {
      applyMessage(entry.message, entry.message.createdAt, entry.key, true)
    } else if (entry.type === "tool") {
      const existing = tools.get(entry.toolCallId)
      const block =
        existing ??
        ({
          key: entry.key,
          type: "tool",
          id: entry.toolCallId,
          name: entry.toolName,
          args: entry.args,
          output: "",
          status: "pending",
        } satisfies ToolBlock)
      block.args = entry.args ?? block.args
      if (isRecord(entry.result) && "content" in entry.result) {
        const content = contentText(entry.result.content)
        if (content) block.output = content
        if ("details" in entry.result) block.details = entry.result.details
      } else {
        block.output = resultText(entry.result)
      }
      block.status = entry.isError
        ? "error"
        : entry.status === "done"
          ? "done"
          : "running"
      // Tool execution has started — the LLM finished generating arguments.
      block.streaming = false
      if (entry.terminal) {
        block.terminal = entry.terminal
        if (entry.terminalMessage) block.terminalMessage = entry.terminalMessage
      }
      if (!existing) {
        currentAgent().blocks.push(block)
        tools.set(entry.toolCallId, block)
      }
    } else if (entry.body) {
      currentAgent().blocks.push({
        key: entry.key,
        type: "error",
        body: entry.body,
      })
    }
  }

  return items.filter((item) => item.type !== "agent" || item.blocks.length > 0)
}
