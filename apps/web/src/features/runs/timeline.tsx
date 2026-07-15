import {
  Bot,
  Brain,
  CircleAlert,
  Clock3,
  MessageSquare,
  Terminal,
  Wrench,
} from "lucide-react"
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
  if (typeof value === "string") {
    return value
  }
  if (value === null || value === undefined) {
    return ""
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function formatTime(value: string | number | null | undefined) {
  if (!value) {
    return "Not available"
  }
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

function messageKey(message: unknown) {
  if (!isRecord(message)) return null
  const role = text(message.role)
  const timestamp = text(message.timestamp)
  return role && timestamp ? `${role}:${timestamp}` : null
}

export type TimelineItem = {
  key: string
  kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "result"
    | "error"
    | "system"
  label: string
  body: string
  timestamp?: string | number
}

function contentItems(
  content: unknown,
  key: string,
  role: string,
  timestamp?: string | number
): TimelineItem[] {
  const values = Array.isArray(content) ? content : [content]
  return values.flatMap<TimelineItem>((part, index) => {
    if (typeof part === "string") {
      return [
        {
          key: `${key}:${index}`,
          kind: role === "user" ? "user" : "assistant",
          label: role,
          body: part,
          timestamp,
        },
      ]
    }
    if (!isRecord(part)) return []
    if (part.type === "text") {
      return [
        {
          key: `${key}:${index}`,
          kind: role === "user" ? "user" : "assistant",
          label: role,
          body: text(part.text),
          timestamp,
        },
      ]
    }
    if (part.type === "thinking") {
      return [
        {
          key: `${key}:${index}`,
          kind: "thinking",
          label: "Thinking",
          body: text(part.thinking),
          timestamp,
        },
      ]
    }
    if (part.type === "toolCall") {
      return [
        {
          key: `${key}:${text(part.id) || index}`,
          kind: "tool",
          label: `Tool call · ${text(part.name) || "unknown"}`,
          body: text(part.arguments),
          timestamp,
        },
      ]
    }
    if (part.type === "image") {
      return [
        {
          key: `${key}:${index}`,
          kind: "system",
          label: "Image",
          body: text(part.mimeType) || "Image content",
          timestamp,
        },
      ]
    }
    return [
      {
        key: `${key}:${index}`,
        kind: "system",
        label: text(part.type) || role,
        body: text(part),
        timestamp,
      },
    ]
  })
}

function entryItems(entry: SessionEntry): TimelineItem[] {
  if (entry.type === "message" && isRecord(entry.message)) {
    const message = entry.message
    const role = text(message.role)
    const timestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : entry.timestamp
    if (role === "toolResult") {
      return [
        {
          key: entry.id,
          kind: message.isError ? "error" : "result",
          label: `${message.isError ? "Tool error" : "Tool result"} · ${text(message.toolName) || "unknown"}`,
          body:
            contentItems(message.content, entry.id, role, timestamp)
              .map((item) => item.body)
              .filter(Boolean)
              .join("\n") || text(message.details),
          timestamp,
        },
      ]
    }
    return contentItems(message.content, entry.id, role, timestamp)
  }
  if (entry.type === "model_change") {
    return [
      {
        key: entry.id,
        kind: "system",
        label: "Model changed",
        body: `${text(entry.provider)} / ${text(entry.modelId)}`,
        timestamp: entry.timestamp,
      },
    ]
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [
      {
        key: entry.id,
        kind: "system",
        label:
          entry.type === "compaction" ? "Context compacted" : "Branch summary",
        body: text(entry.summary),
        timestamp: entry.timestamp,
      },
    ]
  }
  return []
}

export function liveItems(payload: Record<string, unknown>): TimelineItem[] {
  const type = text(payload.type)
  const message = isRecord(payload.message) ? payload.message : null
  if (
    (type === "message_start" ||
      type === "message_update" ||
      type === "message_end") &&
    message
  ) {
    const items = contentItems(
      message.content,
      messageKey(message) ?? type,
      text(message.role),
      typeof message.timestamp === "number" ? message.timestamp : undefined
    )
    return items
  }
  if (type.startsWith("tool_execution_")) {
    const ended = type === "tool_execution_end"
    return [
      {
        key: `tool:${text(payload.toolCallId)}`,
        kind: payload.isError ? "error" : ended ? "result" : "tool",
        label: `${ended ? (payload.isError ? "Tool error" : "Tool result") : "Running tool"} · ${text(payload.toolName) || "unknown"}`,
        body: text(
          ended ? payload.result : (payload.partialResult ?? payload.args)
        ),
      },
    ]
  }
  if (type.includes("error") || payload.error) {
    return [
      {
        key: `event:${type}`,
        kind: "error",
        label: "Run error",
        body: text(payload.error ?? payload.errorMessage ?? payload.message),
      },
    ]
  }
  return []
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const Icon =
    item.kind === "thinking"
      ? Brain
      : item.kind === "tool"
        ? Wrench
        : item.kind === "result"
          ? Terminal
          : item.kind === "error"
            ? CircleAlert
            : item.kind === "user"
              ? MessageSquare
              : item.kind === "assistant"
                ? Bot
                : Clock3
  const time = item.timestamp ? formatConversationTime(item.timestamp) : null

  if (item.kind === "user") {
    return (
      <article className="flex justify-end py-3">
        <div className="max-w-[88%] rounded-lg border bg-muted/45 px-3 py-2.5 sm:max-w-[46rem]">
          <div className="mb-1 flex items-center justify-between gap-4 text-muted-foreground text-xs">
            <span className="font-medium">You</span>
            {time && <time>{time}</time>}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">
            {item.body}
          </p>
        </div>
      </article>
    )
  }

  if (item.kind === "assistant") {
    return (
      <article className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2.5 py-4">
        <div className="flex size-7 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-medium text-sm">Assistant</h4>
            {time && (
              <time className="shrink-0 text-muted-foreground text-xs">
                {time}
              </time>
            )}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
            {item.body}
          </p>
        </div>
      </article>
    )
  }

  if (item.kind === "thinking") {
    return (
      <article className="border-l-2 border-muted px-3 py-2.5">
        <details>
          <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground text-xs">
            <Brain className="size-3.5" />
            <span className="font-medium">Thinking</span>
            {time && <time className="ml-auto">{time}</time>}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-muted-foreground text-xs leading-5">
            {item.body}
          </pre>
        </details>
      </article>
    )
  }

  return (
    <article
      className={
        item.kind === "error"
          ? "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 border-l-2 border-destructive bg-destructive/5 px-3 py-3"
          : "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 border-l-2 border-muted px-3 py-3"
      }
    >
      <Icon
        className={
          item.kind === "error"
            ? "mt-0.5 size-4 text-destructive"
            : "mt-0.5 size-4 text-muted-foreground"
        }
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="font-medium text-xs">{item.label}</h4>
          {time && (
            <time className="text-[11px] text-muted-foreground">{time}</time>
          )}
        </div>
        {item.body && (
          <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs leading-5">
            {item.body}
          </pre>
        )}
      </div>
    </article>
  )
}

export function Conversation({
  history,
  live,
}: {
  history: SessionEntry[]
  live: TimelineItem[]
}) {
  const persistedKeys = history.flatMap((entry) => {
    if (entry.type !== "message" || !isRecord(entry.message)) return []
    const key = messageKey(entry.message)
    const toolKey = text(entry.message.toolCallId)
    return [key, toolKey ? `tool:${toolKey}` : null].filter(Boolean) as string[]
  })
  const historyItems = history.flatMap(entryItems)
  const liveOnly = live.filter(
    (item) =>
      !persistedKeys.some(
        (key) => item.key === key || item.key.startsWith(`${key}:`)
      )
  )
  if (historyItems.length === 0 && liveOnly.length === 0) {
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
    <div className="mx-auto w-full max-w-3xl px-1">
      {historyItems.map((item) => (
        <TimelineRow item={item} key={item.key} />
      ))}
      <div aria-live="polite">
        {liveOnly.map((item) => (
          <TimelineRow item={item} key={item.key} />
        ))}
      </div>
    </div>
  )
}
