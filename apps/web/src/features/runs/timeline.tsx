import { isRecord } from "@aegisx/shared"
import {
  ArrowDown,
  ArrowLeftRight,
  Boxes,
  Brain,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  FileText,
  Flag,
  FolderOpen,
  Gauge,
  GitFork,
  LoaderCircle,
  Pencil,
  Play,
  ScrollText,
  Search,
  Shrink,
  Square,
  Terminal,
  Undo2,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import type { AgentDetail } from "@/api"
import { MessageBody } from "@/components/markdown"
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
  formatTokens,
  type SystemVariant,
  type ToolBlock,
  toolStatusLabel,
} from "@/domain/conversation"
import { formatDuration } from "@/lib/format"
import { useMarkdownPrefs } from "@/lib/markdown-prefs"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import type { ConversationStore } from "@/stream/conversation-store"

import { ToolCustomBody, usesCustomToolBody } from "./tool-render"

function formatClock(value: string | number | undefined) {
  if (value === undefined) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  })
}

function tsMs(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const ms = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function copyText(value: string) {
  void navigator.clipboard.writeText(value).then(
    () => toast.success("已复制"),
    () => toast.error("复制失败")
  )
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
      : value === null || value === undefined
        ? "null"
        : typeof value === "object"
          ? (JSON.stringify(value, null, 2) ?? "undefined")
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : ""
  return formatted.length > 64_000
    ? `${formatted.slice(0, 64_000)}\n\n[输出预览已截断]`
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
        <pre className="p-2.5 font-mono text-xs leading-5 wrap-break-word whitespace-pre-wrap">
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
                  className="w-24 px-2.5 py-0.5 text-left align-top font-mono leading-5 font-medium text-muted-foreground"
                  scope="row"
                >
                  {key}
                </th>
                <td className="min-w-0 px-2.5 py-0.5 align-top">
                  <pre className="font-mono leading-5 wrap-break-word whitespace-pre-wrap">
                    {formatToolCell(item)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {allRows.length > rows.length && (
          <p className="px-2.5 pt-1 text-muted-foreground">仅显示前 200 条。</p>
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
  return Wrench
}

const activityTriggerClass =
  "flex w-full cursor-pointer items-center justify-start gap-2 rounded-sm py-1 text-left text-muted-foreground text-sm hover:text-foreground data-panel-open:[&>svg:last-child]:rotate-90"

function terminalLabel(tool: ToolBlock): string | null {
  switch (tool.terminal) {
    case "timed_out":
      return "已超时"
    case "cancelled":
      return "已取消"
    case "failed":
      return "失败"
    default:
      return null
  }
}

/** Committed tool "参数生成 · 执行" double-duration badge text, or null when
 * neither is recorded (still running, or a pre-v10 row with no meta). */
function toolDuration(tool: ToolBlock): string | null {
  const parts: string[] = []
  if (tool.genMs !== undefined) parts.push(`参数 ${formatDuration(tool.genMs)}`)
  if (tool.execMs !== undefined)
    parts.push(`执行 ${formatDuration(tool.execMs)}`)
  return parts.length > 0 ? parts.join(" · ") : null
}

function ToolActivity({
  tool,
  separated = false,
}: {
  tool: ToolBlock
  separated?: boolean
}) {
  const isError = tool.status === "error"
  const label = isError ? (terminalLabel(tool) ?? "失败") : null
  // Bash exit code (structured in details) — surfaced as a chip so a failed
  // probe shows its specific code (1 / 139 / ...) at a glance, not just 失败.
  const exitCode =
    tool.name === "bash" &&
    isRecord(tool.details) &&
    typeof tool.details.exitCode === "number"
      ? tool.details.exitCode
      : null
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
      return undefined
    }
    // W6: prefer the server-known start (true elapsed, incl. time before the
    // dialog opened); fall back to first-seen local time for legacy data.
    startedRef.current = tool.startedAt ?? Date.now()
    setElapsed(Date.now() - startedRef.current)
    const id = setInterval(() => {
      if (startedRef.current !== null)
        setElapsed(Date.now() - startedRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [tool.status, tool.startedAt])
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
        {toolDuration(tool) && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {toolDuration(tool)}
          </span>
        )}
        {elapsed !== null && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDuration(elapsed)}
          </span>
        )}
        {label && (
          <span
            className="shrink-0 text-xs text-destructive"
            title={tool.terminalMessage ?? undefined}
          >
            {label}
          </span>
        )}
        {exitCode !== null && exitCode !== 0 && (
          <span
            className="shrink-0 font-mono text-xs text-destructive"
            title="退出码"
          >
            退出码 {exitCode}
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
            {usesCustomToolBody(tool.name) ? (
              <ToolCustomBody tool={tool} />
            ) : (
              <>
                {tool.args !== null && tool.args !== undefined && (
                  <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)]">
                    <div className="flex justify-center border-r py-2.5 font-mono text-xs font-semibold text-muted-foreground">
                      I
                    </div>
                    <ToolData value={tool.args} />
                  </div>
                )}
                {tool.output && (
                  <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] border-t">
                    <div
                      className={cn(
                        "flex justify-center border-r py-2.5 font-mono text-xs font-semibold text-muted-foreground",
                        tool.status === "error" && "text-destructive"
                      )}
                    >
                      O
                    </div>
                    <ToolData value={tool.output} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

const SYSTEM_VARIANT_ICONS: Record<SystemVariant, LucideIcon> = {
  compaction: Shrink,
  branch: GitFork,
  model: ArrowLeftRight,
  thinking: Gauge,
}

function systemVariantIcon(variant: SystemVariant): LucideIcon {
  return SYSTEM_VARIANT_ICONS[variant]
}

/** Unified collapsible/static row for meta events (system prompt, tool defs,
 * compaction, model switch, ...). Renders a plain non-interactive row when
 * there is no body; otherwise a collapsible matching ToolActivity's style. */
function MetaActivity({
  icon: Icon,
  label,
  meta,
  body,
}: {
  icon: LucideIcon
  label: string
  meta?: string
  body?: ReactNode
}) {
  if (!body) {
    return (
      <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {meta && (
          <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>
        )}
      </div>
    )
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className={activityTriggerClass}>
        <Icon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {meta && (
          <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>
        )}
        <ChevronRight className="size-3.5 shrink-0 transition-transform" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1 ml-5 min-w-0 pb-2">{body}</div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

/** Small ghost icon action for the per-message meta rows (复制 / 回滚). */
function MetaIconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Button
      aria-label={label}
      className="size-5 text-muted-foreground"
      onClick={onClick}
      size="icon-xs"
      title={label}
      type="button"
      variant="ghost"
    >
      <Icon />
    </Button>
  )
}

const ConversationRow = memo(function ConversationRow({
  item,
  onBacktrack,
  isTurnEnd,
  turnStartMs,
}: {
  item: ConversationItem
  /** Flat-backtrack affordance (v12): shown on committed user/agent rows;
   * the seq of the row's opening entry is the truncation target. */
  onBacktrack?: (seq: number) => void
  /** Turn-scoped meta (user-time anchored): the row closes a turn and the
   * epoch ms of the user message that started it (null when unknown). */
  isTurnEnd?: boolean
  turnStartMs?: number | null
}) {
  const [prefs] = useMarkdownPrefs()
  if (item.type === "user") {
    return (
      <article className="flex flex-col items-end py-5">
        <div className="max-w-[90%] rounded-lg border bg-muted/45 px-4 py-3">
          <MessageBody markdown={prefs.user}>{item.body}</MessageBody>
        </div>
        <div className="mt-1 flex items-center gap-0.5 text-xs text-muted-foreground">
          {formatClock(item.timestamp) && (
            <span className="mr-1 tabular-nums">
              {formatClock(item.timestamp)}
            </span>
          )}
          <MetaIconButton
            icon={Copy}
            label="复制"
            onClick={() => copyText(item.body)}
          />
          {onBacktrack && item.seq !== undefined && (
            <MetaIconButton
              icon={Undo2}
              label="回滚到此"
              onClick={() => {
                const seq = item.seq
                if (seq !== undefined) onBacktrack(seq)
              }}
            />
          )}
        </div>
      </article>
    )
  }
  if (item.type === "system") {
    const body = item.body?.trim() ? (
      <ScrollArea className="h-auto max-h-96" scrollFade scrollbarGutter>
        <MessageBody markdown={prefs.system}>{item.body}</MessageBody>
      </ScrollArea>
    ) : undefined
    return (
      <article>
        <MetaActivity
          body={body}
          icon={systemVariantIcon(item.variant)}
          label={item.title}
        />
      </article>
    )
  }
  const turnMs =
    item.endTs !== undefined && turnStartMs != null
      ? item.endTs - turnStartMs
      : undefined
  const usage = item.usage
  return (
    <article className="relative py-4 text-sm leading-6">
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
                <MessageBody markdown={prefs.assistant}>
                  {block.body}
                </MessageBody>
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
                    推理
                    {block.durationMs !== undefined
                      ? ` · ${formatDuration(block.durationMs)}`
                      : ""}
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 transition-transform" />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="mt-1 ml-5 min-w-0 pb-2 text-muted-foreground">
                    <MessageBody markdown={prefs.thinking}>
                      {block.body}
                    </MessageBody>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            )
          }
          if (block.type === "error") {
            return (
              <div
                className={cn(
                  "flex gap-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground",
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
      {isTurnEnd && (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {formatClock(item.timestamp) && (
            <span className="tabular-nums">{formatClock(item.timestamp)}</span>
          )}
          {turnMs !== undefined && (
            <span className="tabular-nums">本轮 {formatDuration(turnMs)}</span>
          )}
          {usage && (
            <span className="font-mono tabular-nums">
              ↑{formatTokens(usage.input + usage.cacheRead)} ↓
              {formatTokens(usage.output)}
              {usage.cost > 0 && ` · $${usage.cost.toFixed(3)}`}
            </span>
          )}
          <MetaIconButton
            icon={Copy}
            label="复制"
            onClick={() =>
              copyText(
                item.blocks
                  .filter(
                    (
                      block
                    ): block is { key: string; type: "text"; body: string } =>
                      block.type === "text"
                  )
                  .map((block) => block.body)
                  .join("\n\n")
              )
            }
          />
        </div>
      )}
    </article>
  )
})

/** One tool's definition, expandable to its description + JSON-schema. */
function ToolDefinitionRow({
  tool,
}: {
  tool: AgentDetail["toolDefinitions"][number]
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className={activityTriggerClass}>
        <Wrench
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono">{tool.name}</span>
          {tool.description ? (
            <span className="ml-1.5 text-muted-foreground">
              {tool.description}
            </span>
          ) : null}
        </span>
        <ChevronRight className="size-3.5 shrink-0 transition-transform" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1 ml-5 min-w-0 pb-2">
          {tool.description ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {tool.description}
            </p>
          ) : null}
          {tool.promptGuidelines && tool.promptGuidelines.length > 0 ? (
            <ul className="mb-2 list-disc pl-4 text-xs text-muted-foreground">
              {tool.promptGuidelines.map((guideline, index) => (
                <li key={index}>{guideline}</li>
              ))}
            </ul>
          ) : null}
          <pre className="font-mono text-xs leading-5 wrap-break-word whitespace-pre-wrap">
            {JSON.stringify(tool.parameters, null, 2)}
          </pre>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

/** Head-of-timeline agent config: the snapshotted system prompt (plain text)
 * and the tool definitions (name/description/JSON-schema), as two MetaActivity
 * rows that sit before the first user message. Both are immutable per run
 * (createAgent writes them once). Collapsed by default — system prompts are
 * long. Falls back to name-only chips when no definition snapshot exists. */
function AgentConfig({ agent }: { agent: AgentDetail }) {
  const toolCount =
    agent.toolDefinitions.length > 0
      ? agent.toolDefinitions.length
      : agent.tools.length
  return (
    <>
      <MetaActivity
        body={
          <pre className="font-mono text-xs leading-5 wrap-break-word whitespace-pre-wrap">
            {agent.systemPrompt || "（无系统提示词）"}
          </pre>
        }
        icon={ScrollText}
        label="系统提示词"
      />
      <MetaActivity
        body={
          agent.toolDefinitions.length > 0 ? (
            <div className="space-y-0.5">
              {agent.toolDefinitions.map((tool) => (
                <ToolDefinitionRow key={tool.name} tool={tool} />
              ))}
            </div>
          ) : agent.tools.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {agent.tools.map((name) => (
                <span
                  className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground"
                  key={name}
                >
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">无</p>
          )
        }
        icon={Boxes}
        label="工具定义"
        meta={`${toolCount} 工具`}
      />
    </>
  )
}

/**
 * Scrollable conversation timeline for one agent. Merges durable committed
 * messages with ephemeral live progress from the store. Must be rendered inside
 * a coss <ScrollArea>; it locates the viewport via data-slot to drive
 * follow-latest scrolling, overflow detection, and a "最新" jump button.
 */
export function Timeline({
  agentId,
  stream,
  agent,
  canBacktrack = false,
  onBacktrack,
  footer,
  running = false,
}: {
  agentId: string
  stream: ConversationStore
  agent?: AgentDetail
  /** Show the flat-backtrack affordance on committed rows (v12). */
  canBacktrack?: boolean
  onBacktrack?: (seq: number) => void
  /** Tail content rendered after the last message, inside the scrollable
   * timeline (e.g. the live working-status indicator). */
  footer?: ReactNode
  /** Whether the agent is mid-turn — drives the screen-reader turn
   * announcements (start on a new user message, end on running → false). */
  running?: boolean
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

  // Turn bookkeeping for the per-message meta rows: the epoch ms of the
  // user message that opened each agent group's turn (null before the first
  // user message), and which agent groups close a turn (the next item is a
  // user message / end of list) — only those show time / duration / usage.
  const turnMeta = useMemo(() => {
    const startByKey = new Map<string, number | null>()
    const endKeys = new Set<string>()
    let lastUserMs: number | null = null
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item.type === "user") {
        lastUserMs = tsMs(item.timestamp) ?? null
      } else if (item.type === "agent") {
        startByKey.set(item.key, lastUserMs)
        const next = items[index + 1]
        if (!next || next.type === "user") endKeys.add(item.key)
      }
    }
    return { startByKey, endKeys }
  }, [items])

  // Screen-reader announcements only on turn transitions — a per-delta
  // "活动已更新" would flood during streaming.
  const [announcement, setAnnouncement] = useState("")
  const userCount = useMemo(
    () =>
      items.reduce(
        (count, item) => (item.type === "user" ? count + 1 : count),
        0
      ),
    [items]
  )
  const prevUserCount = useRef(userCount)
  const prevRunning = useRef(running)
  useEffect(() => {
    if (userCount > prevUserCount.current) setAnnouncement("新回合开始")
    prevUserCount.current = userCount
  }, [userCount])
  useEffect(() => {
    if (prevRunning.current && !running) setAnnouncement("回合结束")
    prevRunning.current = running
  }, [running])

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
      return undefined
    }
    const viewport = rootRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) {
      viewportRef.current = null
      setScrollContainer(null)
      return undefined
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
          <EmptyTitle>暂无对话</EmptyTitle>
          <EmptyDescription>
            agent 的输出和工具活动将显示在这里。
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
      {agent && <AgentConfig agent={agent} />}
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
              最新
            </Button>
          </div>,
          scrollContainer
        )}
      {items.map((item) => (
        <ConversationRow
          isTurnEnd={
            item.type === "agent" ? turnMeta.endKeys.has(item.key) : undefined
          }
          item={item}
          key={item.key}
          onBacktrack={canBacktrack ? onBacktrack : undefined}
          turnStartMs={
            item.type === "agent"
              ? (turnMeta.startByKey.get(item.key) ?? null)
              : undefined
          }
        />
      ))}
      {footer}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
