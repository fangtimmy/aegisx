import {
  ArrowDown,
  Brain,
  ChevronRight,
  CircleAlert,
  FileText,
  Flag,
  FolderOpen,
  GitFork,
  LoaderCircle,
  Pencil,
  Play,
  Search,
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
import type { AgentStatus, ConversationToolExpandPrefs } from "@/api"
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
import { cn } from "@/lib/utils"
import { AgentStatusIcon } from "./agent-status-icon"
import type { ConversationStore } from "./run-stream-store"
import {
  type ConversationItem,
  isRecord,
  type ToolBlock,
  toolStatusParts,
} from "./timeline-model"
import { shouldAutoExpandTool } from "./tool-expand"
import { ToolCustomBody, usesCustomToolBody } from "./tool-render"

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

function formatDuration(durationMs: number) {
  const seconds = durationMs / 1000
  if (seconds < 10) return `${Math.max(0.1, seconds).toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function ToolSummaryLine({ tool }: { tool: ToolBlock }) {
  const running = tool.status === "pending" || tool.status === "running"
  if (tool.streaming) {
    return (
      <span className="min-w-0 flex-1 truncate">Generating {tool.name}…</span>
    )
  }
  const { verb, subject, subjectKind } = toolStatusParts(
    tool.name,
    tool.args,
    running
  )
  if (!subject) {
    return <span className="min-w-0 flex-1 truncate">{verb}</span>
  }
  if (subjectKind === "path") {
    return (
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0">{verb}</span>
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          dir="rtl"
          title={subject}
        >
          <bdi dir="ltr">{subject}</bdi>
        </span>
      </span>
    )
  }
  return (
    <span className="min-w-0 flex-1 truncate" title={`${verb} ${subject}`}>
      {verb} {subject}
    </span>
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

const activityTriggerClass =
  "flex w-full cursor-pointer items-center justify-start gap-2 rounded-sm py-1 text-left text-muted-foreground text-sm hover:text-foreground data-panel-open:sticky data-panel-open:top-0 data-panel-open:z-10 data-panel-open:bg-card data-panel-open:[&>svg:last-child]:rotate-90"

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
  expandPrefs,
}: {
  tool: ToolBlock
  separated?: boolean
  expandPrefs: ConversationToolExpandPrefs
}) {
  const isError = tool.status === "error"
  const isStreaming = tool.streaming === true
  const label = isError ? (terminalLabel(tool) ?? "Failed") : null
  const StatusIcon = isStreaming
    ? LoaderCircle
    : tool.status === "running"
      ? LoaderCircle
      : isError
        ? CircleAlert
        : toolIcon(tool.name)
  const autoExpand = shouldAutoExpandTool(tool.name, tool.status, expandPrefs)
  const [open, setOpen] = useState(autoExpand)
  useEffect(() => {
    if (autoExpand) setOpen(true)
  }, [autoExpand])
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
  const custom = usesCustomToolBody(tool.name)
  return (
    <Collapsible
      className={separated ? "mt-3" : undefined}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className={activityTriggerClass}>
        <StatusIcon
          className={
            isError
              ? "size-3.5 shrink-0 text-destructive"
              : tool.status === "running" || isStreaming
                ? "size-3.5 shrink-0 animate-spin text-muted-foreground"
                : "size-3.5 shrink-0 text-muted-foreground"
          }
        />
        <ToolSummaryLine tool={tool} />
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
          {custom ? (
            <div
              className={cn(
                "overflow-hidden rounded-md border bg-muted/30",
                isError && "border-destructive/30 bg-destructive/5"
              )}
            >
              <ToolCustomBody tool={tool} />
            </div>
          ) : (
            <div
              className={cn(
                "overflow-hidden rounded-md border bg-muted/30",
                isError && "border-destructive/30 bg-destructive/5"
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
                      isError && "text-destructive"
                    )}
                  >
                    O
                  </div>
                  <ToolData value={tool.output} />
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

const TextBlock = memo(function TextBlock({
  body,
  separated,
  isAnimating,
}: {
  body: string
  separated?: boolean
  isAnimating?: boolean
}) {
  return (
    <div className={cn(separated && "mt-3")}>
      <Markdown isAnimating={isAnimating}>{body}</Markdown>
    </div>
  )
})

const ConversationRow = memo(function ConversationRow({
  item,
  expandPrefs,
  isAnimating = false,
  renderUserMessagesAsMarkdown,
  renderReasoningAsMarkdown,
}: {
  item: ConversationItem
  expandPrefs: ConversationToolExpandPrefs
  isAnimating?: boolean
  renderUserMessagesAsMarkdown: boolean
  renderReasoningAsMarkdown: boolean
}) {
  const time = item.timestamp ? formatConversationTime(item.timestamp) : null
  if (item.type === "user") {
    return (
      <article className="flex justify-end py-5">
        <div className="max-w-[90%] rounded-lg border bg-muted/45 px-4 py-3">
          {renderUserMessagesAsMarkdown ? (
            <Markdown>{item.body}</Markdown>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-6">
              {item.body}
            </p>
          )}
        </div>
      </article>
    )
  }
  if (item.type === "system") {
    return (
      <article className="py-3">
        <p className="text-center text-muted-foreground text-xs">{item.body}</p>
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
            <Markdown isAnimating={isAnimating}>{item.body}</Markdown>
          </div>
        </div>
      </article>
    )
  }
  return (
    <article className="py-4">
      <div className="flex min-w-0 flex-col gap-0">
        {item.blocks.map((block, index) => {
          const previous = item.blocks[index - 1]
          const activity = block.type === "tool" || block.type === "reasoning"
          const previousActivity =
            previous?.type === "tool" || previous?.type === "reasoning"
          const separated = index > 0 && !(activity && previousActivity)
          if (block.type === "text") {
            return (
              <TextBlock
                body={block.body}
                isAnimating={isAnimating}
                key={block.key}
                separated={separated}
              />
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
                    {renderReasoningAsMarkdown ? (
                      <Markdown isAnimating={isAnimating}>
                        {block.body}
                      </Markdown>
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm leading-6">
                        {block.body}
                      </p>
                    )}
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
            <ToolActivity
              expandPrefs={expandPrefs}
              key={block.key}
              separated={separated}
              tool={block}
            />
          )
        })}
      </div>
    </article>
  )
})

export function Conversation({
  agentId,
  stream,
  expandPrefs,
  agentStatus,
  renderUserMessagesAsMarkdown,
  renderReasoningAsMarkdown,
}: {
  agentId: string
  stream: ConversationStore
  expandPrefs: ConversationToolExpandPrefs
  agentStatus?: AgentStatus
  renderUserMessagesAsMarkdown: boolean
  renderReasoningAsMarkdown: boolean
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
      {items.map((item, index) => (
        <ConversationRow
          expandPrefs={expandPrefs}
          isAnimating={agentStatus === "running" && index === items.length - 1}
          item={item}
          key={item.key}
          renderUserMessagesAsMarkdown={renderUserMessagesAsMarkdown}
          renderReasoningAsMarkdown={renderReasoningAsMarkdown}
        />
      ))}
      <div aria-live="polite" className="sr-only">
        {items.length > 0 ? "Agent activity updated" : ""}
      </div>
    </div>
  )
}
