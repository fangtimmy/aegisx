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
import { useDeferredValue, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip"
import type { AgentStatus, SessionEntry } from "@/lib/api"
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
      className="group"
      open={tool.status === "running" || tool.status === "error" || undefined}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-muted-foreground text-sm hover:text-foreground">
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
      <div className="mt-0.5 ml-5 flex min-w-0 flex-col gap-1 pb-1">
        {tool.args !== null && tool.args !== undefined && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5">
            {text(tool.args)}
          </pre>
        )}
        {tool.output && (
          <pre
            className={
              tool.status === "error"
                ? "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-xs leading-5"
                : "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5"
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
  const [atBottom, setAtBottom] = useState(true)
  const deferredLive = useDeferredValue(live)
  const items = buildConversation(history, deferredLive)
  const latestItem = items.at(-1)

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const viewport = viewportRef.current
    if (!viewport) return
    followsLatest.current = true
    setAtBottom(true)
    viewport.scrollTo({ top: viewport.scrollHeight, behavior })
  }

  useEffect(() => {
    const viewport = rootRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) return
    viewportRef.current = viewport
    const updateFollowState = () => {
      const next =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
      followsLatest.current = next
      setAtBottom(next)
    }
    updateFollowState()
    viewport.addEventListener("scroll", updateFollowState, { passive: true })
    return () => viewport.removeEventListener("scroll", updateFollowState)
  }, [])

  useEffect(() => {
    if (latestItem && followsLatest.current) {
      const viewport = viewportRef.current
      if (viewport) {
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
      {!atBottom && (
        <div className="pointer-events-none sticky top-[calc(100%-3.25rem)] z-10 flex h-0 justify-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Jump to latest activity"
                  className="pointer-events-auto rounded-full bg-background shadow-md"
                  onClick={() => scrollToBottom("smooth")}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                />
              }
            >
              <ArrowDown aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>Jump to latest activity</TooltipPopup>
          </Tooltip>
        </div>
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
