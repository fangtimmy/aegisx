import type {
  CompactionEntry,
  EntryItem,
  SessionEntry,
  SessionMessageEntry,
  TimingBlock,
  TimingMeta,
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

/** Extract a file path from tool args (filePath preferred over path). */
export function toolFilePath(args: unknown): string {
  if (!isRecord(args)) return ""
  return text(args.filePath || args.path).trim()
}

function truncateLabel(value: string, limit = 100): string {
  const line = value.split("\n", 1)[0].trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** Human label for a tool block header (v4 native + coding tools). */
export function toolStatusLabel(
  name: string,
  args: unknown,
  running: boolean
): string {
  const a = isRecord(args) ? args : null
  const subject = (() => {
    switch (name) {
      case "bash":
        return truncateLabel(text(a?.command), 80)
      case "read":
      case "write":
      case "edit":
        return truncateLabel(toolFilePath(a))
      case "grep":
      case "find": {
        const pattern = text(a?.pattern)
        return pattern ? `"${pattern}"` : ""
      }
      case "ls":
        return truncateLabel(text(a?.path)) || ""
      case "spawn_agent":
        return truncateLabel(text(a?.name)) || truncateLabel(text(a?.task), 60)
      case "inspect_agent":
        return truncateLabel(text(a?.agent_id)) || ""
      default:
        return ""
    }
  })()
  const verb = (() => {
    switch (name) {
      case "bash":
        return running ? "正在运行" : "已运行"
      case "read":
        return running ? "正在读取" : "已读取"
      case "write":
        return running ? "正在写入" : "已写入"
      case "edit":
        return running ? "正在编辑" : "已编辑"
      case "grep":
        return running ? "正在搜索" : "已搜索"
      case "find":
        return running ? "正在查找" : "已查找"
      case "ls":
        return running ? "正在列出" : "已列出"
      case "submit_flag":
        return running ? "正在提交 flag" : "已提交 flag"
      case "finish_run":
        return running ? "正在结束任务" : "已结束任务"
      case "spawn_agent":
        return running ? "正在派生 agent" : "已派生 agent"
      case "inspect_agent":
        return running ? "正在检查 agent" : "已检查 agent"
      case "get_target":
        return running ? "正在检查目标" : "已检查目标"
      case "start_target":
        return running ? "正在启动目标" : "已启动目标"
      case "extend_target":
        return running ? "正在延长目标" : "已延长目标"
      case "stop_target":
        return running ? "正在停止目标" : "已停止目标"
      default:
        return running ? `正在运行 ${name}` : name
    }
  })()
  const label = subject ? `${verb} ${subject}` : verb
  return label.length > 100 ? `${label.slice(0, 99)}…` : label
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      entry: SessionEntry
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
  terminal?: "timed_out" | "cancelled" | "failed"
  terminalMessage?: string
  /** Argument-generation time (the assistant toolCall block timing). */
  genMs?: number
  /** Tool execution time (the toolResult meta.durationMs). */
  execMs?: number
}

type AgentBlock =
  | { key: string; type: "text"; body: string }
  | { key: string; type: "reasoning"; body: string; durationMs?: number }
  | { key: string; type: "error"; body: string }
  | ToolBlock

export type SystemVariant = "compaction" | "branch" | "model" | "thinking"

export type ConversationItem =
  | {
      key: string
      type: "system"
      variant: SystemVariant
      title: string
      detail?: string
      /** Expandable body (compaction / branch_summary text). Omitted for
       * marker-only events (model_change, thinking_level_change). */
      body?: string
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

type ConversationAgentItem = Extract<ConversationItem, { type: "agent" }>

function applyUser(
  entry: SessionMessageEntry,
  items: ConversationItem[],
  stableKey: string
) {
  const message = entry.message
  if (message.role !== "user") return
  const body = contentText(message.content)
  if (!body) return
  items.push({
    key: stableKey,
    type: "user",
    body,
    timestamp: entry.timestamp,
  })
}

/** Format a token count like the pi-TUI compaction marker. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function applyCompaction(
  entry: CompactionEntry,
  items: ConversationItem[],
  stableKey: string
) {
  const title = `已压缩 ${formatTokens(entry.tokensBefore)} token`
  items.push({
    key: stableKey,
    type: "system",
    variant: "compaction",
    title,
    body: entry.summary,
    timestamp: entry.timestamp,
  })
}

/** Extract a tool's structured terminal reason from its result details
 * (the bash tool attaches `terminal` on timeout / abort / non-zero exit). */
function terminalOfDetails(
  details: unknown
): "timed_out" | "cancelled" | "failed" | undefined {
  if (!isRecord(details)) return undefined
  const terminal = details.terminal
  return terminal === "timed_out" ||
    terminal === "cancelled" ||
    terminal === "failed"
    ? terminal
    : undefined
}

function applyToolResult(
  entry: SessionMessageEntry,
  tools: Map<string, ToolBlock>,
  currentAgent: (timestamp?: string | number) => ConversationAgentItem,
  meta?: TimingMeta
) {
  const message = entry.message
  if (message.role !== "toolResult") return
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
  // The bash tool returns a result (not a throw) on failure, so the SDK's
  // isError is false for non-zero exits — derive the error state from the
  // structured `details.terminal` the tool attaches, falling back to isError
  // for untyped tools that still throw.
  const terminal = terminalOfDetails(message.details)
  block.status = message.isError || terminal ? "error" : "done"
  if (terminal) block.terminal = terminal
  if (meta) block.execMs = meta.durationMs
  if (!existing) {
    currentAgent(entry.timestamp).blocks.push(block)
    tools.set(id, block)
  }
}

function applyAssistant(
  entry: SessionMessageEntry,
  tools: Map<string, ToolBlock>,
  currentAgent: (timestamp?: string | number) => ConversationAgentItem,
  stableKey: string,
  meta?: TimingMeta
) {
  const message = entry.message
  if (message.role !== "assistant") return
  const timestamp = entry.timestamp
  const blocks = currentAgent(timestamp).blocks
  const blockPrefix = stableKey
  const blockTiming = new Map<number, TimingBlock>()
  if (meta?.blocks) for (const b of meta.blocks) blockTiming.set(b.index, b)
  for (const [index, part] of message.content.entries()) {
    const key = `${blockPrefix}:${index}`
    if (!isRecord(part)) continue
    if (part.type === "text") {
      const body = text(part.text)
      if (body.trim()) blocks.push({ key, type: "text", body })
    } else if (part.type === "thinking") {
      const body = text(part.thinking)
      if (body.trim()) {
        const bt = blockTiming.get(index)
        blocks.push({
          key,
          type: "reasoning",
          body,
          ...(bt ? { durationMs: bt.endMs - bt.startMs } : {}),
        })
      }
    } else if (part.type === "toolCall") {
      const id = text(part.id)
      const bt = blockTiming.get(index)
      const block: ToolBlock = {
        key: `tool:${id}`,
        type: "tool",
        id,
        name: text(part.name) || "unknown",
        args: part.arguments,
        output: "",
        status: "pending",
        ...(bt ? { genMs: bt.endMs - bt.startMs } : {}),
      }
      blocks.push(block)
      tools.set(id, block)
    }
  }
  if (message.stopReason === "error" && message.errorMessage) {
    blocks.push({
      key: `${blockPrefix}:error`,
      type: "error",
      body: text(message.errorMessage),
    })
  }
}

export function buildConversation(
  history: EntryItem[],
  live: LiveEntry[]
): ConversationItem[] {
  const items: ConversationItem[] = []
  const tools = new Map<string, ToolBlock>()
  let agent: ConversationAgentItem | null = null

  const currentAgent = (timestamp?: string | number): ConversationAgentItem => {
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

  const applyEntry = (
    entry: SessionEntry,
    stableKey: string,
    meta?: TimingMeta
  ) => {
    if (entry.type === "message") {
      const message = entry.message
      if (message.role === "user") {
        applyUser(entry, items, stableKey)
        agent = null
        return
      }
      if (message.role === "assistant") {
        applyAssistant(entry, tools, currentAgent, stableKey, meta)
        return
      }
      if (message.role === "toolResult") {
        applyToolResult(entry, tools, currentAgent, meta)
        return
      }
      // bashExecution / custom / branchSummary / compactionSummary roles are
      // not produced by AegisX's zero-extension agent; ignore if seen.
      return
    }
    if (entry.type === "compaction") {
      applyCompaction(entry, items, stableKey)
      agent = null
      return
    }
    if (entry.type === "branch_summary") {
      items.push({
        key: stableKey,
        type: "system",
        variant: "branch",
        title: "从更早的节点分叉",
        body: entry.summary,
        timestamp: entry.timestamp,
      })
      agent = null
      return
    }
    if (entry.type === "model_change") {
      items.push({
        key: stableKey,
        type: "system",
        variant: "model",
        title: `已切换模型 → ${entry.provider} / ${entry.modelId}`,
        timestamp: entry.timestamp,
      })
      agent = null
      return
    }
    if (entry.type === "thinking_level_change") {
      items.push({
        key: stableKey,
        type: "system",
        variant: "thinking",
        title: `推理 → ${entry.thinkingLevel}`,
        timestamp: entry.timestamp,
      })
      agent = null
      return
    }
  }

  for (const item of history) {
    applyEntry(item.entry, item.key, item.meta)
  }

  for (const entry of live) {
    if (entry.type === "message") {
      applyEntry(entry.entry, `message:${entry.key}`)
    } else if (entry.type === "tool") {
      const existing = tools.get(entry.toolCallId)
      const block =
        existing ??
        ({
          key: entry.key,
          type: "tool",
          id: entry.toolCallId,
          name: entry.toolName,
          args: null,
          output: "",
          status: "pending",
        } satisfies ToolBlock)
      block.args = entry.args ?? block.args
      block.output = resultText(entry.result)
      if (isRecord(entry.result) && "details" in entry.result)
        block.details = entry.result.details
      block.status = entry.isError
        ? "error"
        : entry.status === "done"
          ? "done"
          : "running"
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
