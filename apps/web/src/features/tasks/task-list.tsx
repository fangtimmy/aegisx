import { isActiveAgentStatus } from "@aegisx/shared"
import { Check, TriangleAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import type { AgentSummary, Challenge, FleetInfo } from "@/api"
import { ListRow } from "@/components/list-row"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { overallSolved } from "@/features/events/event-shared"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

/** The ?c= value selecting the scheduler variant. */
export const ORCH = "orch"

/** Tick cadence for the deadline countdown + stall hints (minute-level). */
const CLOCK_TICK_MS = 30_000
/** A live agent with no update for this long gets a stall hint. */
const STALL_AFTER_MS = 2 * 60_000

export function shortModel(ref: string | null): string {
  if (!ref) return "默认模型"
  const body = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref
  return body.split(":")[0] ?? body
}

/** Deadline remaining with the <10min amber / <5min red coloring. */
export function formatRemaining(
  deadlineAt: string,
  nowMs: number
): { text: string; className: string } {
  const ms = new Date(deadlineAt).getTime() - nowMs
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const text =
    ms <= 0
      ? "已超时"
      : minutes >= 60
        ? `剩 ${Math.floor(minutes / 60)}h${minutes % 60}m`
        : `剩 ${minutes}m`
  const className =
    ms <= 0 || minutes < 5
      ? "text-destructive"
      : minutes < 10
        ? "text-warning"
        : ""
  return { text, className }
}

export function formatAgo(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime()
  if (ms < 60_000) return "刚刚"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m 前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h 前`
  return formatTime(iso)
}

type TaskRow = {
  id: string
  name: string
  category: string | null
  challenge?: Challenge
  agents: AgentSummary[]
  liveCount: number
  runningCount: number
  pendingCount: number
  lastActivityMs: number
  minDeadlineAt: string | null
  stallMinutes: number | null
}

function buildRow(
  challenge: FleetInfo["challenges"][number],
  meta: Challenge | undefined,
  agents: AgentSummary[],
  pendingCount: number
): TaskRow {
  const live = agents.filter((agent) => isActiveAgentStatus(agent.status))
  const deadlines = live
    .filter((agent) => agent.deadlineAt !== null)
    .map((agent) => new Date(agent.deadlineAt!).getTime())
  const lastActivity = Math.max(
    0,
    ...agents.map((agent) => new Date(agent.updatedAt).getTime())
  )
  return {
    id: challenge.id,
    name: challenge.name,
    category: challenge.category ?? meta?.category ?? null,
    challenge: meta,
    agents,
    liveCount: live.length,
    runningCount: live.filter((agent) => agent.status === "running").length,
    pendingCount,
    lastActivityMs: lastActivity,
    minDeadlineAt: deadlines.length
      ? new Date(Math.min(...deadlines)).toISOString()
      : null,
    stallMinutes: null,
  }
}

export function TaskList({
  fleet,
  challengeById,
  pendingByChallenge,
  selected,
  onSelect,
}: {
  fleet: FleetInfo
  challengeById: Map<string, Challenge>
  pendingByChallenge: Map<string, number>
  selected: string | null
  onSelect: (c: string) => void
}) {
  const [query, setQuery] = useState("")
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const { active, silent } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = fleet.challenges
      .map((challenge) =>
        buildRow(
          challenge,
          challengeById.get(challenge.id),
          fleet.agentsByChallenge[challenge.id] ?? [],
          pendingByChallenge.get(challenge.id) ?? 0
        )
      )
      .filter(
        (row) =>
          !needle ||
          row.name.toLowerCase().includes(needle) ||
          (row.category ?? "").toLowerCase().includes(needle)
      )
      .map((row) => {
        const stallMs = Math.max(
          0,
          ...row.agents
            .filter((agent) => isActiveAgentStatus(agent.status))
            .map((agent) => nowMs - new Date(agent.updatedAt).getTime())
        )
        return stallMs > STALL_AFTER_MS
          ? { ...row, stallMinutes: Math.floor(stallMs / 60_000) }
          : row
      })
    const byActivity = (left: TaskRow, right: TaskRow) =>
      right.lastActivityMs - left.lastActivityMs
    return {
      active: rows
        .filter((row) => row.liveCount > 0 || row.pendingCount > 0)
        .sort(byActivity),
      silent: rows
        .filter((row) => row.liveCount === 0 && row.pendingCount === 0)
        .sort(byActivity),
    }
  }, [fleet, challengeById, pendingByChallenge, query, nowMs])

  const schedulerAgent = fleet.schedulerAgent
  const schedActive =
    schedulerAgent !== null && isActiveAgentStatus(schedulerAgent.status)
  const schedLabel = !schedActive
    ? "未启动"
    : fleet.config.paused
      ? "已暂停"
      : "运行中"

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <Input
        aria-label="筛选题名或分类"
        className="h-8 shrink-0"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="筛选题名或分类"
        type="search"
        value={query}
      />
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div className="flex flex-col gap-1 pr-1">
          <ListRow
            className="items-center"
            onClick={() => onSelect(ORCH)}
            selected={selected === ORCH}
          >
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                !schedActive
                  ? "bg-muted-foreground/40"
                  : fleet.config.paused
                    ? "bg-warning"
                    : "bg-success"
              )}
            />
            <span className="shrink-0 text-sm font-medium">调度者</span>
            <span className="truncate text-xs text-muted-foreground">
              {shortModel(schedulerAgent?.model ?? fleet.config.modelId)}
            </span>
            <span
              className={cn(
                "ml-auto shrink-0 text-xs",
                schedActive
                  ? fleet.config.paused
                    ? "text-warning"
                    : "text-success"
                  : "text-muted-foreground"
              )}
            >
              {schedLabel}
            </span>
          </ListRow>

          <GroupHeader count={active.length} label="活跃" />
          {active.map((row) => (
            <TaskRowView
              isSelected={row.id === selected}
              key={row.id}
              nowMs={nowMs}
              onSelect={onSelect}
              row={row}
            />
          ))}
          <GroupHeader count={silent.length} label="沉默" />
          {silent.map((row) => (
            <TaskRowView
              isSelected={row.id === selected}
              key={row.id}
              nowMs={nowMs}
              onSelect={onSelect}
              row={row}
            />
          ))}
          {active.length + silent.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              无匹配题目。
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 border-t px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground uppercase first:border-t-0">
      {label}
      <Badge size="sm" variant="secondary">
        {count}
      </Badge>
    </div>
  )
}

function TaskRowView({
  row,
  isSelected,
  nowMs,
  onSelect,
}: {
  row: TaskRow
  isSelected: boolean
  nowMs: number
  onSelect: (c: string) => void
}) {
  const meta = row.challenge
  const solved = meta ? overallSolved(meta) : "unsolved"
  const acceptedFlags =
    meta?.flags.filter((flag) => flag.status === "accepted").length ?? 0

  const dotClass = row.runningCount
    ? "bg-success"
    : row.liveCount
      ? "bg-warning"
      : "bg-muted-foreground/40"

  const deadline =
    row.minDeadlineAt !== null
      ? formatRemaining(row.minDeadlineAt, nowMs)
      : null

  return (
    <ListRow
      className="flex-col items-stretch gap-0.5"
      onClick={() => onSelect(row.id)}
      selected={isSelected}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", dotClass)}
        />
        <span className="min-w-0 truncate text-sm">
          {row.category && (
            <span className="text-muted-foreground">{row.category}/</span>
          )}
          {row.name}
        </span>
        {row.liveCount > 0 && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {row.liveCount} 活跃
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-4 text-[11px] text-muted-foreground">
        <span className="shrink-0 tabular-nums">{row.agents.length} 尝试</span>
        {deadline && (
          <span className={cn("shrink-0 tabular-nums", deadline.className)}>
            · {deadline.text}
          </span>
        )}
        {solved === "solved" ? (
          <Check aria-label="已解决" className="size-3 shrink-0 text-success" />
        ) : solved === "partial" || acceptedFlags > 0 ? (
          <span className="shrink-0 tabular-nums">
            · {acceptedFlags}/{meta?.flags.length ?? 0}
          </span>
        ) : null}
        {row.pendingCount > 0 && (
          <span className="shrink-0 text-warning">· 排队中</span>
        )}
        {row.stallMinutes !== null && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-warning tabular-nums">
            ·<TriangleAlert aria-hidden className="size-3" />
            {row.stallMinutes}m
          </span>
        )}
      </span>
    </ListRow>
  )
}
