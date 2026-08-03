import {
  ArrowDown,
  Brain,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  Flag,
  FolderOpen,
  GitFork,
  LoaderCircle,
  Pencil,
  Play,
  RotateCw,
  Search,
  Shrink,
  Square,
  Terminal,
  Wrench,
} from "lucide-react"
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { createPortal } from "react-dom"
import type { AgentStatus } from "@/api"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  type ConversationItem,
  isRecord,
  type ToolBlock,
  toolStatusLabel,
} from "@/domain/conversation"
import { cn } from "@/lib/utils"
import type { ConversationStore } from "@/stream/conversation-store"
import { AgentStatusIcon } from "./agent-status-icon"

function formatConversationTime(value: string | number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatDuration(durationMs: number) {
  const seconds = durationMs / 1000
  if (seconds < 10) return `${Math.max(0.1, seconds).toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function toolSummary(tool: ToolBlock) {
  return toolStatusLabel(
    tool.name,
    tool.args,
    tool.status === "pending" || tool.status === "running"
  )
}

function parseToolValue(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function formatToolCell(value: unknown) {
  const formatted =
    typeof value === "string"
      ? value
      : value === null
        ? "null"
        : typeof value === "object"
          ? (JSON.stringify(value, null, 2) ?? "undefined")
          : String(value)
  return formatted.length > 64_000
    ? `${formatted.slice(0, 64_000)}\n\n[Output preview truncated]`
    : formatted
}

function ToolData({ value }: { value: unknown }) {
  const parsed = parseToolValue(value)
  const allRows = Array.isArray(parsed)
    ? parsed.map((item, index) => [String(index), item] as const)
    : isRecord(parsed)
      ? Object.entries(parsed)
      : []
  const rows = allRows.slice(0, 200)
  if (rows.length === 0) {
    return (
      <ScrollArea className="h-auto max-h-80" scrollFade scrollbarGutter>
        <pre className="whitespace-pre-wrap break-words p-2.5 font-mono text-xs leading-5">
          {formatToolCell(parsed)}
        </pre>
      </ScrollArea>
    )
  }
  return (
    <ScrollArea className="h-auto max-h-80" scrollFade scrollbarGutter>
      <div className="py-1.5">
        <table className="w-full table-fixed border-collapse text-xs">
          <tbody>
            {rows.map(([key, item]) => (
              <tr key={key}>
                <th
                  className="w-24 px-2.5 py-0.5 text-left align-top font-mono font-medium text-muted-foreground leading-5"
                  scope="row"
                >
                  {key}
                </th>
                <td className="min-w-0 px-2.5 py-0.5 align-top">
                  <pre className="whitespace-pre-wrap break-words font-mono leading-5">
                    {formatToolCell(item)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {allRows.length > rows.length && (
          <p className="px-2.5 pt-1 text-muted-foreground">
            Showing the first 200 entries.
          </p>
        )}
      </div>
    </ScrollArea>
  )
}

/** Per-tool lucide icon, mapped to v4 native + coding tool names. */
function toolIcon(name: string) {
  if (name === "bash") return Terminal
  if (name === "read") return FileText
  if (name === "grep" || name === "find" || name === "get_target") return Search
  if (name === "edit" || name === "write") return Pencil
  if (name === "ls") return FolderOpen
  if (name === "start_target") return Play
  if (name === "stop_target") return Square
  if (name === "extend_target") return Clock
  if (name === "finish_run" || name === "submit_flag") return Flag
  if (name === "spawn_agent" || name === "inspect_agent") return GitFork
  return Wrench
}

const activityTriggerClass =
  "flex w-full cursor-pointer items-center justify-start gap-2 rounded-sm py-1 text-left text-muted-foreground text-sm hover:text-foreground data-panel-open:[&>svg:last-child]:rotate-90"

function terminalLabel(tool: ToolBlock): string | null {
  switch (tool.terminal) {
    case "timed_out":
      return "Timed out"
    case "cancelled":
      return "Cancelled"
    case "failed":
      return "Failed"
    default:
      return null
  }
}

function ToolActivity({
  tool,
  separated = false,
}: {
  tool: ToolBlock
  separated?: boolean
}) {
  const isError = tool.status === "error"
  const label = isError ? (terminalLabel(tool) ?? "Failed") : null
  const StatusIcon =
    tool.status === "running"
      ? LoaderCircle
      : isError
        ? CircleAlert
        : toolIcon(tool.name)
  const startedRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (tool.status !== "running") {
      startedRef.current = null
      setElapsed(null)
      return
    }
    if (startedRef.current === null) startedRef.current = Date.now()
    setElapsed(Date.now() - startedRef.current)
    const id = setInterval(() => {
      if (startedRef.current !== null)
        setElapsed(Date.now() - startedRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [tool.status])
  return (
    <Collapsible className={separated ? "mt-3" : undefined}>
      <CollapsibleTrigger className={activityTriggerClass}>
        <StatusIcon
          className={
            isError
              ? "size-3.5 shrink-0 text-destructive"
              : tool.status === "running"
                ? "size-3.5 shrink-0 animate-spin text-muted-foreground"
                : "size-3.5 shrink-0 text-muted-foreground"
          }
        />
        <span className="min-w-0 flex-1 truncate">{toolSummary(tool)}</span>
        {elapsed !== null && (
          <span className="shrink-0 text-muted-foreground text-xs">
            {formatDuration(elapsed)}
          </span>
        )}
        {label && (
          <span
            className="shrink-0 text-destructive text-xs"
            title={tool.terminalMessage ?? undefined}
          >
            {label}
          </span>
        )}
        <ChevronRight className="size-3.5 shrink-0 transition-transform" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1 ml-5 min-w-0 pb-2">
          <div
            className={cn(
              "overflow-hidden rounded-md border bg-muted/30",
              tool.status === "error" &&
                "border-destructive/30 bg-destructive/5"
            )}
          >
            {tool.args !== null && tool.args !== undefined && (
              <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)]">
                <div className="flex justify-center border-r py-2.5 font-mono font-semibold text-muted-foreground text-xs">
                  I
                </div>
                <ToolData value={tool.args} />
              </div>
            )}
            {tool.output && (
              <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] border-t">
                <div
                  className={cn(
                    "flex justify-center border-r py-2.5 font-mono font-semibold text-muted-foreground text-xs",
                    tool.status === "error" && "text-destructive"
                  )}
                >
                  O
                </div>
                <ToolData value={tool.output} />
              </div>
            )}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

const ConversationRow = memo(function ConversationRow({
  item,
}: {
  item: ConversationItem
}) {
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
  if (item.type === "handoff") {
    return (
      <article className="py-4">
        <div className="flex min-w-0 items-start gap-3">
          <GitFork
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">
                {item.agentName}
              </span>
              <AgentStatusIcon
                className="[&_svg]:size-3.5"
                status={item.status as AgentStatus}
              />
              <span className="capitalize">{item.status}</span>
              {time && <time className="ml-auto">{time}</time>}
            </div>
            <Markdown>{item.body}</Markdown>
          </div>
        </div>
      </article>
    )
  }
  if (item.type === "system") {
    const isCompaction =
      item.kind === "compact_start" || item.kind === "compact_end"
    const Icon = isCompaction ? Shrink : RotateCw
    return (
      <article className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-medium">{item.title}</span>
        {item.detail && (
          <span className="min-w-0 max-w-[60%] truncate">{item.detail}</span>
        )}
        {time && <time className="shrink-0">{time}</time>}
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </article>
    )
  }
  return (
    <article className="py-4 text-sm leading-6">
      <div className="flex min-w-0 flex-col gap-0">
        {item.blocks.map((block, index) => {
          const previous = item.blocks[index - 1]
          const activity = block.type === "tool" || block.type === "reasoning"
          const previousActivity =
            previous?.type === "tool" || previous?.type === "reasoning"
          const separated = index > 0 && !(activity && previousActivity)
          if (block.type === "text") {
            return (
              <div
                className={cn("min-w-0", separated && "mt-3")}
                key={block.key}
              >
                <Markdown isAnimating>{block.body}</Markdown>
              </div>
            )
          }
          if (block.type === "reasoning") {
            return (
              <Collapsible
                className={separated ? "mt-3" : undefined}
                key={block.key}
              >
                <CollapsibleTrigger className={activityTriggerClass}>
                  <Brain className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    Reasoning
                    {block.durationMs !== undefined
                      ? ` · ${formatDuration(block.durationMs)}`
                      : ""}
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 transition-transform" />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="mt-1 ml-5 min-w-0 pb-2 text-muted-foreground">
                    <Markdown>{block.body}</Markdown>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            )
          }
          if (block.type === "error") {
            return (
              <div
                className={cn(
                  "flex gap-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-destructive-foreground text-sm",
                  separated && "mt-3"
                )}
                key={block.key}
                role="alert"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{block.body}</span>
              </div>
            )
          }
          return (
            <ToolActivity key={block.key} separated={separated} tool={block} />
          )
        })}
      </div>
    </article>
  )
})

/**
 * Scrollable conversation timeline for one agent. Merges durable committed
 * messages with ephemeral live progress from the store. Must be rendered inside
 * a coss <ScrollArea>; it locates the viewport via data-slot to drive
 * follow-latest scrolling, overflow detection, and a "Latest" jump button.
 */
export function Timeline({
  agentId,
  stream,
}: {
  agentId: string
  stream: ConversationStore
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLElement>(null)
  const followsLatest = useRef(true)
  const lastScrollTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  )
  const items = useSyncExternalStore(
    useCallback(
      (listener) => stream.subscribe(agentId, listener),
      [agentId, stream]
    ),
    useCallback(() => stream.get(agentId), [agentId, stream]),
    useCallback(() => stream.get(agentId), [agentId, stream])
  )
  const hasConversation = items.length > 0
  const latestItem = items.at(-1)
  const showJumpToLatest = hasOverflow && !atBottom

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const viewport = viewportRef.current
    if (!viewport) return
    followsLatest.current = true
    setAtBottom(true)
    viewport.scrollTo({ top: viewport.scrollHeight, behavior })
  }

  useEffect(() => {
    if (!hasConversation) {
      viewportRef.current = null
      setScrollContainer(null)
      return
    }
    const viewport = rootRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) {
      viewportRef.current = null
      setScrollContainer(null)
      return
    }
    viewportRef.current = viewport
    setScrollContainer(viewport.parentElement)
    lastScrollTop.current = viewport.scrollTop
    const updateFollowState = () => {
      const bottomDistance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const isAtBottom = bottomDistance <= 4
      const movedUp = viewport.scrollTop < lastScrollTop.current - 1
      lastScrollTop.current = viewport.scrollTop
      setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 1)
      if (isAtBottom) {
        followsLatest.current = true
        setAtBottom(true)
      } else if (movedUp) {
        followsLatest.current = false
        setAtBottom(false)
      } else if (!followsLatest.current) {
        setAtBottom(false)
      }
    }
    updateFollowState()
    viewport.addEventListener("scroll", updateFollowState, { passive: true })
    const resizeObserver = new ResizeObserver(() => {
      if (followsLatest.current) {
        viewport.scrollTo({ top: viewport.scrollHeight })
      }
      updateFollowState()
    })
    resizeObserver.observe(rootRef.current ?? viewport)
    return () => {
      viewport.removeEventListener("scroll", updateFollowState)
      resizeObserver.disconnect()
    }
  }, [hasConversation])

  useEffect(() => {
    if (latestItem && followsLatest.current) {
      const viewport = viewportRef.current
      if (viewport) {
        setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 1)
        setAtBottom(true)
        viewport.scrollTo({ top: viewport.scrollHeight })
      }
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
    <div
      className="relative mx-auto min-h-full w-full max-w-3xl px-6 pb-6"
      ref={rootRef}
    >
      {scrollContainer &&
        createPortal(
          <div
            aria-hidden={!showJumpToLatest}
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center transition-opacity duration-200",
              showJumpToLatest ? "opacity-100" : "opacity-0"
            )}
          >
            <Button
              className={cn(
                showJumpToLatest ? "pointer-events-auto" : "pointer-events-none"
              )}
              onClick={() => scrollToBottom("smooth")}
              tabIndex={showJumpToLatest ? 0 : -1}
              type="button"
            >
              <ArrowDown aria-hidden="true" />
              Latest
            </Button>
          </div>,
          scrollContainer
        )}
      {items.map((item) => (
        <ConversationRow item={item} key={item.key} />
      ))}
      <div aria-live="polite" className="sr-only">
        {items.length > 0 ? "Agent activity updated" : ""}
      </div>
    </div>
  )
}
