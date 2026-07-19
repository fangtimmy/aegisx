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
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
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
import type { AgentStatus, SessionEntry } from "@/lib/api"
import { cn } from "@/lib/utils"
import { AgentStatusIcon } from "./agent-status-icon"
import {
  buildConversation,
  type ConversationItem,
  isRecord,
  type LiveEntry,
  type ToolBlock,
  text,
} from "./timeline-model"

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

const Markdown = memo(function Markdown({ children }: { children: string }) {
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
})

function toolSummary(tool: ToolBlock) {
  const args = isRecord(tool.args) ? tool.args : null
  const fixed: Record<string, string> = {
    extend_target: "Extended target lifetime",
    get_target: "Checked target",
    start_target: "Started target",
    stop_target: "Stopped target",
    submit_flag: "Submitted flag",
  }
  if (fixed[tool.name]) return fixed[tool.name]
  const subject =
    tool.name === "bash"
      ? text(args?.command).split("\n", 1)[0]
      : text(args?.path ?? args?.pattern ?? args?.summary ?? args?.name)
  const verb =
    tool.name === "bash"
      ? "Ran"
      : tool.name === "read"
        ? "Read"
        : tool.name === "grep"
          ? "Searched"
          : tool.name === "find"
            ? "Found"
            : tool.name === "ls"
              ? "Listed"
              : tool.name === "edit" || tool.name === "write"
                ? "Updated"
                : tool.name === "finish_run"
                  ? "Completed run"
                  : tool.name === "spawn_agent"
                    ? "Started agent"
                    : tool.name === "inspect_agent"
                      ? "Inspected agent"
                      : tool.name
  const label = subject ? `${verb} ${subject}` : verb
  return label.length > 100 ? `${label.slice(0, 99)}…` : label
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
  if (typeof value === "string") return value
  if (value === null) return "null"
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  return String(value)
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

function ToolActivity({
  tool,
  separated = false,
}: {
  tool: ToolBlock
  separated?: boolean
}) {
  const StatusIcon =
    tool.status === "running"
      ? LoaderCircle
      : tool.status === "error"
        ? CircleAlert
        : toolIcon(tool.name)
  return (
    <Collapsible className={separated ? "mt-3" : undefined}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-start gap-2 rounded-sm py-1 text-left text-muted-foreground text-sm hover:text-foreground data-panel-open:[&>svg:last-child]:rotate-90">
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
        {tool.status === "running" && (
          <span className="shrink-0 text-xs">Running</span>
        )}
        {tool.status === "error" && (
          <span className="shrink-0 text-destructive text-xs">Failed</span>
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
  return (
    <article className="py-4">
      <div className="flex min-w-0 flex-col gap-0">
        {item.blocks.map((block, index) => {
          const previous = item.blocks[index - 1]
          const separated =
            index > 0 && !(block.type === "tool" && previous?.type === "tool")
          if (block.type === "text") {
            return (
              <div className={separated ? "mt-3" : undefined} key={block.key}>
                <Markdown>{block.body}</Markdown>
              </div>
            )
          }
          if (block.type === "reasoning") {
            return (
              <details
                className={cn("group py-0.5", separated && "mt-3")}
                key={block.key}
              >
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
  const lastScrollTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  )
  const items = useMemo(() => buildConversation(history, live), [history, live])
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
        {live.length > 0 ? "Agent activity updated" : ""}
      </div>
    </div>
  )
}
