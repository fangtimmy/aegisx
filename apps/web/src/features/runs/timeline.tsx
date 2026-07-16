import {
  BotMessageSquare,
  Brain,
  ChevronRight,
  CircleAlert,
  FileText,
  Flag,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Play,
  Search,
  Square,
  Terminal,
  Wrench,
} from "lucide-react"
import { useEffect, useRef } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import type { SessionEntry } from "@/lib/api"

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

export function formatTime(value: string | number | null | undefined) {
  if (!value) return "Not available"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value))
}

function formatConversationTime(value: string | number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function messageKey(message: Record<string, unknown>) {
  const role = text(message.role)
  const timestamp = text(message.timestamp)
  return role && timestamp ? `message:${role}:${timestamp}` : null
}

export type LiveEntry =
  | {
      key: string
      type: "message"
      message: Record<string, unknown>
      endedAt?: number
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
    }
  | {
      key: string
      type: "error"
      body: string
    }

type ToolBlock = {
  key: string
  type: "tool"
  id: string
  name: string
  args: unknown
  output: string
  status: "pending" | "running" | "done" | "error"
}

type AgentBlock =
  | { key: string; type: "text"; body: string }
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
  | {
      key: string
      type: "notice"
      label: string
      body: string
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

function messageTimestamp(
  message: Record<string, unknown>,
  fallback?: string | number
) {
  return typeof message.timestamp === "number" ? message.timestamp : fallback
}

function messageDuration(
  message: Record<string, unknown>,
  endedAt?: string | number
) {
  if (typeof message.timestamp !== "number" || endedAt === undefined) {
    return undefined
  }
  const end =
    typeof endedAt === "number" ? endedAt : new Date(endedAt).getTime()
  const duration = end - message.timestamp
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function formatDuration(durationMs: number) {
  const seconds = durationMs / 1000
  if (seconds < 10) return `${Math.max(0.1, seconds).toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

export function liveEntries(payload: Record<string, unknown>): LiveEntry[] {
  const type = text(payload.type)
  const message = isRecord(payload.message) ? payload.message : null
  if (
    (type === "message_start" ||
      type === "message_update" ||
      type === "message_end") &&
    message
  ) {
    const key = messageKey(message)
    return key
      ? [
          {
            key,
            type: "message",
            message,
            endedAt: type === "message_end" ? Date.now() : undefined,
          },
        ]
      : []
  }
  if (type.startsWith("tool_execution_")) {
    const toolCallId = text(payload.toolCallId)
    if (!toolCallId) return []
    const ended = type === "tool_execution_end"
    return [
      {
        key: `tool:${toolCallId}`,
        type: "tool",
        toolCallId,
        toolName: text(payload.toolName) || "unknown",
        args: payload.args,
        result: ended ? payload.result : payload.partialResult,
        isError: Boolean(payload.isError),
        status: ended ? "done" : "running",
      },
    ]
  }
  if (type.includes("error") || payload.error) {
    return [
      {
        key: `error:${type}`,
        type: "error",
        body: text(payload.error ?? payload.errorMessage ?? payload.message),
      },
    ]
  }
  return []
}

export function buildConversation(
  history: SessionEntry[],
  live: LiveEntry[]
): ConversationItem[] {
  const items: ConversationItem[] = []
  const tools = new Map<string, ToolBlock>()
  const persistedMessages = new Set<string>()
  const persistedTools = new Set<string>()
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
    message: Record<string, unknown>,
    fallback?: string | number
  ) {
    const role = text(message.role)
    const timestamp = messageTimestamp(message, fallback)
    if (role === "user") {
      const body = contentText(message.content)
      if (body) {
        const handoff = body.match(
          /^Background agent (.+) \(([^)]+)\) (completed|failed|stopped)\.\n\nFinal output:\n\n([\s\S]*)$/
        )
        items.push(
          handoff
            ? {
                key: messageKey(message) ?? `handoff:${items.length}`,
                type: "handoff",
                agentName: handoff[1],
                agentId: handoff[2],
                status: handoff[3],
                body: handoff[4],
                timestamp,
              }
            : {
                key: messageKey(message) ?? `user:${items.length}`,
                type: "user",
                body,
                timestamp,
              }
        )
      }
      agent = null
      return
    }
    if (role === "toolResult") {
      const id = text(message.toolCallId)
      const existing = tools.get(id)
      const block =
        existing ??
        ({
          key: `tool:${id}`,
          type: "tool",
          id,
          name: text(message.toolName) || "unknown",
          args: null,
          output: "",
          status: "pending",
        } satisfies ToolBlock)
      block.output = contentText(message.content) || resultText(message.details)
      block.status = message.isError ? "error" : "done"
      if (!existing) {
        currentAgent(timestamp).blocks.push(block)
        tools.set(id, block)
      }
      return
    }
    if (role !== "assistant") return

    const blocks = currentAgent(timestamp).blocks
    const blockPrefix =
      messageKey(message) ?? `message:${timestamp ?? items.length}`
    const durationMs = messageDuration(message, fallback)
    const content = Array.isArray(message.content)
      ? message.content
      : [message.content]
    for (const [index, part] of content.entries()) {
      const key = `${blockPrefix}:${index}`
      if (typeof part === "string") {
        if (part.trim()) blocks.push({ key, type: "text", body: part })
        continue
      }
      if (!isRecord(part)) continue
      if (part.type === "text") {
        const body = text(part.text)
        if (body.trim()) blocks.push({ key, type: "text", body })
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

  for (const entry of history) {
    if (entry.type === "message" && isRecord(entry.message)) {
      const key = messageKey(entry.message)
      if (key) persistedMessages.add(key)
      if (entry.message.role === "toolResult") {
        const id = text(entry.message.toolCallId)
        if (id) persistedTools.add(`tool:${id}`)
      }
      applyMessage(entry.message, entry.timestamp)
    } else if (entry.type === "model_change") {
      items.push({
        key: entry.id,
        type: "notice",
        label: `Model changed to ${text(entry.modelId)}`,
        body: "",
        timestamp: entry.timestamp,
      })
      agent = null
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      items.push({
        key: entry.id,
        type: "notice",
        label:
          entry.type === "compaction" ? "Context compacted" : "Branch summary",
        body: text(entry.summary),
        timestamp: entry.timestamp,
      })
      agent = null
    }
  }

  for (const entry of live) {
    if (entry.type === "message") {
      const key = messageKey(entry.message)
      const toolKey =
        entry.message.role === "toolResult"
          ? `tool:${text(entry.message.toolCallId)}`
          : null
      if (
        (key && persistedMessages.has(key)) ||
        (toolKey && persistedTools.has(toolKey))
      ) {
        continue
      }
      applyMessage(entry.message, entry.endedAt)
    } else if (entry.type === "tool") {
      if (persistedTools.has(entry.key)) continue
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
      block.output = resultText(entry.result)
      block.status = entry.isError
        ? "error"
        : entry.status === "done"
          ? "done"
          : "running"
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

function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-6 [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-3 [&_h1]:font-semibold [&_h1]:text-xl [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-lg [&_h3]:mb-2 [&_h3]:font-semibold [&_h3]:text-base [&_li]:ml-5 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:mb-3 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:p-2 [&_ul]:my-3">
      <ReactMarkdown
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} rel="noreferrer" target="_blank" />
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function toolSummary(tool: ToolBlock) {
  const args = isRecord(tool.args) ? tool.args : null
  const subject =
    tool.name === "bash"
      ? text(args?.command).split("\n", 1)[0]
      : text(args?.path ?? args?.pattern ?? args?.summary)
  const verb =
    tool.name === "bash"
      ? "Ran"
      : tool.name === "read"
        ? "Read"
        : tool.name === "grep"
          ? "Searched"
          : tool.name === "edit" || tool.name === "write"
            ? "Updated"
            : tool.name
  const label = subject ? `${verb} ${subject}` : verb
  return label.length > 100 ? `${label.slice(0, 99)}…` : label
}

function toolIcon(name: string) {
  if (name === "bash") return Terminal
  if (name === "read") return FileText
  if (name === "grep" || name === "find") return Search
  if (name === "edit" || name === "write") return Pencil
  if (name === "ls") return FolderOpen
  if (name === "start_target") return Play
  if (name === "stop_target") return Square
  if (name === "finish_run" || name === "submit_flag") return Flag
  return Wrench
}

function ToolActivity({ tool }: { tool: ToolBlock }) {
  const StatusIcon =
    tool.status === "running"
      ? LoaderCircle
      : tool.status === "error"
        ? CircleAlert
        : toolIcon(tool.name)
  return (
    <details
      className="group py-0.5"
      open={tool.status === "running" || tool.status === "error" || undefined}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1.5 text-muted-foreground text-sm hover:text-foreground">
        <StatusIcon
          className={
            tool.status === "error"
              ? "size-3.5 shrink-0 text-destructive"
              : tool.status === "running"
                ? "size-3.5 shrink-0 animate-spin text-muted-foreground"
                : "size-3.5 shrink-0 text-muted-foreground"
          }
        />
        <span className="min-w-0 flex-1 truncate">{toolSummary(tool)}</span>
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-1 ml-5 flex min-w-0 flex-col gap-2 pb-2">
        {tool.args !== null && tool.args !== undefined && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5">
            {text(tool.args)}
          </pre>
        )}
        {tool.output && (
          <pre
            className={
              tool.status === "error"
                ? "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs leading-5"
                : "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5"
            }
          >
            {tool.output}
          </pre>
        )}
      </div>
    </details>
  )
}

function ConversationRow({ item }: { item: ConversationItem }) {
  const time = item.timestamp ? formatConversationTime(item.timestamp) : null
  if (item.type === "user") {
    return (
      <article className="flex justify-end py-5">
        <div className="max-w-[90%] rounded-lg border bg-muted/45 px-4 py-3">
          <Markdown>{item.body}</Markdown>
        </div>
      </article>
    )
  }
  if (item.type === "notice") {
    return (
      <div className="flex items-center gap-3 py-3 text-muted-foreground text-xs">
        <div className="h-px flex-1 bg-border" />
        {item.body ? (
          <details>
            <summary className="cursor-pointer">{item.label}</summary>
            <p className="mt-2 max-w-xl whitespace-pre-wrap text-center leading-5">
              {item.body}
            </p>
          </details>
        ) : (
          <span>{item.label}</span>
        )}
        {time && <time>{time}</time>}
        <div className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (item.type === "handoff") {
    return (
      <article className="py-5">
        <div className="border-l-2 border-primary bg-muted/30 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
            <BotMessageSquare className="size-4" />
            <span className="font-medium text-foreground">
              Agent handoff · {item.agentName}
            </span>
            <span>{item.status}</span>
            {time && <time className="ml-auto">{time}</time>}
          </div>
          <Markdown>{item.body}</Markdown>
        </div>
      </article>
    )
  }
  return (
    <article className="py-5">
      <div className="flex min-w-0 flex-col gap-3">
        {item.blocks.map((block) => {
          if (block.type === "text") {
            return <Markdown key={block.key}>{block.body}</Markdown>
          }
          if (block.type === "reasoning") {
            return (
              <details className="group py-0.5" key={block.key}>
                <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-muted-foreground text-sm">
                  <Brain className="size-3.5" />
                  <span>
                    Reasoning
                    {block.durationMs !== undefined
                      ? ` · ${formatDuration(block.durationMs)}`
                      : ""}
                  </span>
                  <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
                </summary>
                <div className="mt-2 ml-5 text-muted-foreground">
                  <Markdown>{block.body}</Markdown>
                </div>
              </details>
            )
          }
          if (block.type === "error") {
            return (
              <div
                className="flex gap-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-destructive-foreground text-sm"
                key={block.key}
                role="alert"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{block.body}</span>
              </div>
            )
          }
          return <ToolActivity key={block.key} tool={block} />
        })}
      </div>
    </article>
  )
}

export function Conversation({
  history,
  live,
}: {
  history: SessionEntry[]
  live: LiveEntry[]
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLElement>(null)
  const followsLatest = useRef(true)
  const items = buildConversation(history, live)
  const latestItem = items.at(-1)

  useEffect(() => {
    const viewport = rootRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) return
    viewportRef.current = viewport
    const updateFollowState = () => {
      followsLatest.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
    }
    viewport.addEventListener("scroll", updateFollowState, { passive: true })
    return () => viewport.removeEventListener("scroll", updateFollowState)
  }, [])

  useEffect(() => {
    if (latestItem && followsLatest.current) {
      const viewport = viewportRef.current
      viewport?.scrollTo({ top: viewport.scrollHeight })
    }
  }, [latestItem])

  if (items.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyTitle>No conversation yet</EmptyTitle>
          <EmptyDescription>
            Agent output and tool activity will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-6" ref={rootRef}>
      {items.map((item) => (
        <ConversationRow item={item} key={item.key} />
      ))}
      <div aria-live="polite" className="sr-only">
        {live.length > 0 ? "Agent activity updated" : ""}
      </div>
    </div>
  )
}
