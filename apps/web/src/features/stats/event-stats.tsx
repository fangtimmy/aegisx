import { useQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { useState } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts"

import { eventsApi, keys } from "@/api"
import type {
  EventAgentEfficiency,
  EventChallengeEfficiency,
  EventStats,
  EventStatsAgentSpan,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip"
import { ErrorState } from "@/features/events/event-shared"
import {
  agentStatusLabel,
  agentStatusVisual,
  formatCost,
  formatTokens,
} from "@/features/runs/agent-overview"
import { formatDurationClock, formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Statistics tab: derived per-event analytics (score / billing / efficiency /
 * concurrency / timeline / collaboration). No polling — a derived view that
 * changes only with agent activity; refresh is explicit. */
export function EventStatsPanel({ eventId }: { eventId: string }) {
  const stats = useQuery({
    queryKey: keys.events.stats(eventId),
    queryFn: () => eventsApi.getEventStats(eventId),
  })

  if (stats.isPending) {
    return (
      <div className="flex flex-col gap-4 p-1">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    )
  }
  if (stats.error) {
    return <ErrorState error={stats.error} retry={() => stats.refetch()} />
  }

  const data = stats.data.stats
  const empty =
    data.overview.attempts === 0 && data.overview.challengesTotal === 0
  if (empty) {
    return (
      <Empty className="mx-auto mt-16 max-w-md">
        <EmptyHeader>
          <EmptyTitle>暂无统计数据</EmptyTitle>
          <EmptyDescription>
            接入平台同步题目、派出 Agent
            后，这里会给出赛事的解题、消耗与调度复盘。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-4 p-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">统计</h1>
          <Button
            onClick={() => void stats.refetch()}
            size="sm"
            variant="outline"
          >
            <RefreshCw /> 刷新
          </Button>
        </div>

        <OverviewCards data={data} />
        <ScoreChart data={data} />
        <AgentTimeline data={data} />
        <ConcurrencyChart data={data} />
        <AgentEfficiency data={data} />
        <ModelBilling data={data} />
        <CategoryStats data={data} />
        <ChallengeEfficiency data={data} />
        <CollaborationCards data={data} />
      </div>
    </ScrollArea>
  )
}

function OverviewCards({ data }: { data: EventStats }) {
  const o = data.overview
  const durationMs =
    data.window.start && data.window.end
      ? Math.max(0, Date.parse(data.window.end) - Date.parse(data.window.start))
      : 0
  const cells: Array<{
    label: string
    value: string
    hint?: string
    /** Efficiency ratios fill the 6-col xl grid two cells wide, so 9 cells
     * end flush instead of stranding the last row's right half. */
    wide?: boolean
  }> = [
    {
      label: "解题进度",
      value: `${o.challengesSolved} / ${o.challengesTotal}`,
      hint: `得分 ${o.pointsEarned}${o.pointsAvailable > 0 ? ` / ${o.pointsAvailable}` : ""}`,
    },
    { label: "总费用", value: formatCost(o.cost), hint: `${o.turns} 轮请求` },
    {
      label: "总 token",
      value: formatTokens(o.inputTokens + o.outputTokens),
      hint: `输入 ${formatTokens(o.inputTokens)} · 输出 ${formatTokens(o.outputTokens)}`,
    },
    {
      label: "尝试次数",
      value: `${o.attempts}`,
      hint: `活跃 ${o.attemptsActive} · 超时 ${data.failures.timeouts}`,
    },
    {
      label: "活动时长",
      value: durationMs > 0 ? formatDurationClock(durationMs) : "—",
      hint:
        data.window.start && data.window.end
          ? `${formatTime(data.window.start)} 起`
          : undefined,
    },
    {
      label: "队列",
      value: `${data.queue.done} 完成`,
      hint: `失败 ${data.queue.failed} · 取消 ${data.queue.cancelled}`,
    },
  ]
  if (o.challengesSolved > 0 && o.cost > 0) {
    cells.push({
      label: "费用 / 解出",
      value: formatCost(o.cost / o.challengesSolved),
      wide: true,
    })
    if (o.pointsEarned > 0) {
      cells.push({
        label: "费用 / 得分",
        value: formatCost(o.cost / o.pointsEarned),
        hint: "每得一分的花费",
        wide: true,
      })
    }
    cells.push({
      label: "token / 解出",
      value: formatTokens(
        (o.inputTokens + o.outputTokens) / o.challengesSolved
      ),
      wide: true,
    })
  }
  return (
    <Card>
      <CardPanel className="grid grid-cols-2 gap-y-3 sm:grid-cols-3 xl:grid-cols-6 xl:divide-x">
        {cells.map((cell) => (
          <div
            className={cn(
              "flex flex-col gap-0.5 px-4 py-3",
              cell.wide && "xl:col-span-2"
            )}
            key={cell.label}
          >
            <span className="text-xs text-muted-foreground">{cell.label}</span>
            <span className="font-semibold tabular-nums">{cell.value}</span>
            {cell.hint && (
              <span className="text-xs text-muted-foreground">{cell.hint}</span>
            )}
          </div>
        ))}
      </CardPanel>
    </Card>
  )
}

/** Recharts' default tooltip is an unstyled white box that clashes with the
 * dark theme — theme it with popover tokens so both modes read correctly. */
const chartTooltip = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgb(0 0 0 / 0.2)",
    fontSize: 12,
    color: "var(--popover-foreground)",
  },
  labelStyle: { color: "var(--muted-foreground)" },
  itemStyle: { color: "var(--popover-foreground)" },
} as const

/** Padded [start, end] domain + 5 explicit ticks for a time axis. Recharts'
 * own tick generation on numeric time axes is unreliable (single tick on
 * multi-hour windows, overlapping labels on degenerate ones), so both the
 * domain padding and the ticks are computed here. */
function timeAxis(startMs: number, endMs: number) {
  const span = Math.max(0, endMs - startMs)
  const pad = Math.max(span * 0.03, 60_000)
  const lo = startMs - pad
  const hi = endMs + pad
  const ticks = Array.from({ length: 5 }, (_, i) =>
    Math.round(lo + ((hi - lo) * i) / 4)
  )
  return { domain: [lo, hi] as [number, number], ticks }
}

/** Whole-number Y ticks: every integer for small maxima, otherwise a
 * half-way tick — recharts' auto ticks pick uneven steps (0/6/12/21). */
function integerTicks(max: number): number[] {
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i)
  return [0, Math.round(max / 2), max]
}

/** Custom score tooltip: recharts' default would only show the cumulative
 * value — the solved challenge name (already computed per point) is what a
 * reviewer actually wants at hover time. */
function ScoreTooltipContent(props: {
  active?: boolean
  payload?: ReadonlyArray<{
    payload?: { t?: number; cumulative?: number; label?: string }
  }>
}) {
  if (!props.active) return null
  const point = props.payload?.[0]?.payload
  if (!point) return null
  return (
    <div className="flex flex-col gap-0.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md/5">
      <span className="text-muted-foreground">
        {formatTime(new Date(point.t ?? 0).toISOString())}
      </span>
      {point.label ? (
        <span className="font-medium text-balance">{point.label}</span>
      ) : null}
      <span className="tabular-nums">累计 {point.cumulative ?? 0} 分</span>
    </div>
  )
}

/** Cumulative earned points over the event window (the赛后 score curve). */
function ScoreChart({ data }: { data: EventStats }) {
  if (data.scoreTimeline.length === 0) return null
  const startMs = data.window.start
    ? Date.parse(data.window.start)
    : Date.parse(data.scoreTimeline[0].time)
  const lastPoint = data.scoreTimeline.at(-1)
  const endMs = data.window.end
    ? Date.parse(data.window.end)
    : lastPoint
      ? Date.parse(lastPoint.time)
      : startMs
  const axis = timeAxis(startMs, endMs)
  const points = [
    { t: startMs, cumulative: 0, label: "" },
    ...data.scoreTimeline.map((point) => ({
      t: Date.parse(point.time),
      cumulative: point.cumulative,
      label: `${point.challengeName} +${point.points}`,
    })),
  ]
  const maxCumulative = Math.max(...points.map((p) => p.cumulative), 1)
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>得分曲线</CardFrameTitle>
        <CardFrameDescription>
          累计得分随时间的变化（{data.scoreTimeline.length} 次解出）
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel>
          <ResponsiveContainer height={220} width="100%">
            <AreaChart
              data={points}
              margin={{ bottom: 0, left: 0, right: 12, top: 8 }}
              syncId="event-stats"
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="t"
                domain={axis.domain}
                tick={{ fontSize: 11 }}
                ticks={axis.ticks}
                tickFormatter={axisTickTime}
                type="number"
              />
              <YAxis
                allowDecimals={false}
                domain={[0, maxCumulative]}
                tick={{ fontSize: 11 }}
                width={44}
              />
              <RechartsTooltip
                content={<ScoreTooltipContent />}
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeOpacity: 0.35,
                }}
              />
              <Area
                dataKey="cumulative"
                dot
                fill="var(--primary)"
                fillOpacity={0.12}
                stroke="var(--primary)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** fig-2 style Gantt: one bar per agent span, hand-rolled divs (recharts has
 * no dense lane layout). "challenge" rows spans by challenge (scheduler on
 * top); "compact" packs them into the fewest tracks via greedy interval
 * packing — for interval graphs the greedy result equals peak concurrency. */
type TimelineMode = "challenge" | "compact"

type TimelineLane = {
  key: string
  /** Null = an unlabeled compact track. */
  title: string | null
  spans: EventStatsAgentSpan[]
}

function timelineLanes(
  spans: EventStatsAgentSpan[],
  mode: TimelineMode
): TimelineLane[] {
  if (mode === "challenge") {
    const lanes: TimelineLane[] = []
    const scheduler = spans.filter((span) => span.challengeId === null)
    if (scheduler.length > 0) {
      lanes.push({ key: ":scheduler", title: "调度者", spans: scheduler })
    }
    const byChallenge = new Map<string, EventStatsAgentSpan[]>()
    for (const span of spans) {
      if (span.challengeId === null) continue
      const values = byChallenge.get(span.challengeId) ?? []
      values.push(span)
      byChallenge.set(span.challengeId, values)
    }
    for (const [challengeId, challengeSpans] of byChallenge) {
      lanes.push({
        key: challengeId,
        title: challengeSpans[0].challengeName ?? challengeId,
        spans: challengeSpans,
      })
    }
    return lanes
  }
  const trackEnds: number[] = []
  const trackOf = new Map<string, number>()
  const order = spans.toSorted(
    (a, b) =>
      Date.parse(a.start) - Date.parse(b.start) ||
      Date.parse(a.end) - Date.parse(b.end)
  )
  for (const span of order) {
    const start = Date.parse(span.start)
    const end = Date.parse(span.end)
    // Best fit: reuse the already-freed track with the latest end.
    let best = -1
    let bestEnd = -Infinity
    for (let i = 0; i < trackEnds.length; i++) {
      if (trackEnds[i] <= start && trackEnds[i] > bestEnd) {
        best = i
        bestEnd = trackEnds[i]
      }
    }
    if (best === -1) {
      trackEnds.push(end)
      trackOf.set(span.id, trackEnds.length - 1)
    } else {
      trackEnds[best] = end
      trackOf.set(span.id, best)
    }
  }
  const tracks: EventStatsAgentSpan[][] = Array.from(
    { length: trackEnds.length },
    () => []
  )
  for (const span of order) {
    tracks[trackOf.get(span.id) ?? 0].push(span)
  }
  return tracks.map((trackSpans, i) => ({
    key: `track-${i}`,
    title: null,
    spans: trackSpans,
  }))
}

function AgentTimeline({ data }: { data: EventStats }) {
  const [mode, setMode] = useState<TimelineMode>("challenge")
  const spans = data.agentTimeline
  if (spans.length === 0) return null
  const starts = spans.map((span) => Date.parse(span.start))
  const ends = spans.map((span) => Date.parse(span.end))
  const domainStart = Math.min(
    ...starts,
    data.window.start ? Date.parse(data.window.start) : Infinity
  )
  const domainEnd = Math.max(
    ...ends,
    data.window.end ? Date.parse(data.window.end) : -Infinity
  )
  const spanMs = Math.max(1, domainEnd - domainStart)

  const lanes = timelineLanes(spans, mode)
  const compact = mode === "compact"

  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Agent 时间线</CardFrameTitle>
        <CardFrameDescription>
          {compact
            ? `最少轨道合并：${lanes.length} 条轨道承载 ${spans.length} 个 Agent`
            : `每个 Agent 的运行区间，按题目分行（${spans.length} 个）`}
        </CardFrameDescription>
        <CardFrameAction>
          <ToggleGroup
            size="sm"
            value={[mode]}
            variant="outline"
            onValueChange={(value) => {
              const next = value.at(-1)
              if (next === "challenge" || next === "compact") {
                setMode(next)
              }
            }}
          >
            <ToggleGroupItem value="challenge">按题目</ToggleGroupItem>
            <ToggleGroupItem value="compact">合并</ToggleGroupItem>
          </ToggleGroup>
        </CardFrameAction>
      </CardFrameHeader>
      <Card>
        <CardPanel className="flex flex-col gap-3">
          <div className="flex justify-between font-mono text-2xs text-muted-foreground">
            <span>{formatTime(new Date(domainStart).toISOString())}</span>
            <span>{formatTime(new Date(domainEnd).toISOString())}</span>
          </div>
          <div className="flex flex-col gap-2">
            {lanes.map((lane) => (
              <div
                className={
                  compact
                    ? "grid items-center"
                    : "grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-2"
                }
                key={lane.key}
              >
                {lane.title !== null && (
                  <span className="truncate text-xs text-muted-foreground">
                    {lane.title}
                  </span>
                )}
                <div className="relative h-5 rounded bg-muted/50">
                  {lane.spans.map((span) => {
                    const start = Date.parse(span.start)
                    const end = Date.parse(span.end)
                    const left = ((start - domainStart) / spanMs) * 100
                    const width = Math.max(0.5, ((end - start) / spanMs) * 100)
                    return (
                      <Tooltip key={span.id}>
                        <TooltipTrigger
                          render={
                            <span
                              className={`absolute top-0.5 h-4 cursor-default rounded-sm ${spanColor(span)}`}
                              style={{ left: `${left}%`, width: `${width}%` }}
                            />
                          }
                        />
                        <TooltipPopup>
                          <span className="flex flex-col gap-0.5 text-left">
                            <span className="font-medium">
                              {span.name} · {agentStatusLabel(span.status)}
                            </span>
                            <span className="font-mono text-2xs text-muted-foreground">
                              {span.model}
                            </span>
                            <span className="tabular-nums">
                              {formatTime(span.start)} → {formatTime(span.end)}
                              （{formatDurationClock(end - start)}）
                            </span>
                          </span>
                        </TooltipPopup>
                      </Tooltip>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

function spanColor(span: EventStatsAgentSpan): string {
  return agentStatusVisual[span.status].span
}

/** Concurrent running solver agents over the event window (step series). */
function ConcurrencyChart({ data }: { data: EventStats }) {
  if (data.concurrency.length === 0) return null
  const points = data.concurrency.map((point) => ({
    t: Date.parse(point.time),
    running: point.running,
  }))
  const first = points[0]
  const last = points.at(-1)
  const startMs = data.window.start ? Date.parse(data.window.start) : first.t
  // The event window bounds the chart — a Date.now() end would compress a
  // finished event into a sliver at the left edge.
  const endMs = Math.max(
    data.window.end ? Date.parse(data.window.end) : 0,
    last ? last.t : first.t
  )
  const axis = timeAxis(startMs, endMs)
  const maxRunning = Math.max(...points.map((p) => p.running), 1)
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>并发利用</CardFrameTitle>
        <CardFrameDescription>
          运行中的求解者 Agent 数量；调度 {data.spawnSource.scheduler} · 手动{" "}
          {data.spawnSource.manual} · 排队均候{" "}
          {data.queue.avgWaitMs !== null
            ? formatDurationClock(data.queue.avgWaitMs)
            : "—"}
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel>
          <ResponsiveContainer height={160} width="100%">
            <AreaChart
              data={points}
              margin={{ bottom: 0, left: 0, right: 12, top: 8 }}
              syncId="event-stats"
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="t"
                domain={axis.domain}
                tick={{ fontSize: 11 }}
                ticks={axis.ticks}
                tickFormatter={axisTickTime}
                type="number"
              />
              <YAxis
                allowDecimals={false}
                domain={[0, maxRunning]}
                tick={{ fontSize: 11 }}
                ticks={integerTicks(maxRunning)}
                width={32}
              />
              <RechartsTooltip
                {...chartTooltip}
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeOpacity: 0.35,
                }}
                formatter={(value) => [`${Number(value)}`, "并发"]}
                labelFormatter={(label) =>
                  formatTime(new Date(Number(label)).toISOString())
                }
              />
              <Area
                dataKey="running"
                fill="var(--success)"
                fillOpacity={0.15}
                stroke="var(--success)"
                strokeWidth={2}
                type="stepAfter"
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** Per-agent ledger: usage / cost / tools / duration / idle, sorted by cost.
 * The description line aggregates solver vs orchestrator spend — the direct
 * answer to "how much does the relay's command layer cost". */
function AgentEfficiency({ data }: { data: EventStats }) {
  if (data.agentEfficiency.length === 0) return null
  const sumRole = (role: EventAgentEfficiency["role"]) => {
    const rows = data.agentEfficiency.filter((row) => row.role === role)
    return {
      count: rows.length,
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
    }
  }
  const solver = sumRole("solver")
  const orchestrator = sumRole("orchestrator")
  const idleRows = data.agentEfficiency.filter((row) => row.idleMs > 0)
  const idleTotal = idleRows.reduce((sum, row) => sum + row.idleMs, 0)
  const share = (part: number) =>
    solver.cost + orchestrator.cost > 0
      ? `（${Math.round((part / (solver.cost + orchestrator.cost)) * 100)}%）`
      : ""
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Agent 投入</CardFrameTitle>
        <CardFrameDescription>
          {`${solver.count} 求解者 ${formatCost(solver.cost)}${share(solver.cost)} · ${orchestrator.count} 调度者 ${formatCost(orchestrator.cost)}${share(orchestrator.cost)}`}
          {idleRows.length > 0 &&
            ` · ${idleRows.length} 个空转中（合计 ${formatDurationClock(idleTotal)}）`}
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="max-h-96 overflow-y-auto p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>题目</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">token</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead className="text-right">轮次</TableHead>
                <TableHead className="text-right">工具</TableHead>
                <TableHead className="text-right">时长</TableHead>
                <TableHead className="text-right">空转</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.agentEfficiency.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-44">
                    <span className="flex flex-col">
                      <span className="truncate text-xs">
                        {row.name ?? row.id}
                      </span>
                      {row.error && (
                        <span
                          className="truncate text-2xs text-destructive"
                          title={row.error}
                        >
                          {row.error}
                        </span>
                      )}
                      {!row.error && row.summary && (
                        <span
                          className="truncate text-2xs text-muted-foreground"
                          title={row.summary}
                        >
                          {row.summary}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-32 truncate text-xs text-muted-foreground">
                    {row.role === "orchestrator" ? "—" : row.challengeName}
                  </TableCell>
                  <TableCell className="max-w-44 truncate font-mono text-xs">
                    {row.model}
                  </TableCell>
                  <TableCell>{statusBadge(row.status)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatTokens(row.input + row.output)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCost(row.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.turns}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.toolCalls}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDurationClock(row.durationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.idleMs > 0 ? formatDurationClock(row.idleMs) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

function statusBadge(status: EventAgentEfficiency["status"]) {
  const variant =
    status === "running"
      ? "success"
      : status === "idle"
        ? "warning"
        : status === "aborted" || status === "failed"
          ? "destructive"
          : "secondary"
  const label =
    status === "running"
      ? "运行"
      : status === "idle"
        ? "空闲"
        : status === "aborted"
          ? "中止"
          : status === "failed"
            ? "失败"
            : "完成"
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  )
}

function ModelBilling({ data }: { data: EventStats }) {
  if (data.modelBilling.length === 0) return null
  const totalCost =
    data.modelBilling.reduce((sum, row) => sum + row.cost, 0) || 1
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>模型账单</CardFrameTitle>
        <CardFrameDescription>
          按模型聚合的请求、费用与解出归因（含调度者）
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">请求</TableHead>
                <TableHead className="text-right">输入</TableHead>
                <TableHead className="text-right">输出</TableHead>
                <TableHead className="text-right">缓存读</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead className="text-right">占比</TableHead>
                <TableHead className="text-right">求解者</TableHead>
                <TableHead className="text-right">解出</TableHead>
                <TableHead className="text-right">费用/解出</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.modelBilling.map((row) => (
                <TableRow key={row.model}>
                  <TableCell className="max-w-64 truncate font-mono text-xs">
                    {row.model}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.requests}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.input)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.output)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.cacheRead)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCost(row.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.round((row.cost / totalCost) * 100)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.solverAgents}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.solves}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.solves > 0 ? formatCost(row.cost / row.solves) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** Challenges grouped by category — solve rate and spend per category. */
function CategoryStats({ data }: { data: EventStats }) {
  if (data.categoryStats.length === 0) return null
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>分类统计</CardFrameTitle>
        <CardFrameDescription>按题目分类聚合的解题与投入</CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>分类</TableHead>
                <TableHead className="text-right">题目</TableHead>
                <TableHead className="text-right">解出</TableHead>
                <TableHead className="text-right">得分</TableHead>
                <TableHead className="text-right">尝试</TableHead>
                <TableHead className="text-right">token</TableHead>
                <TableHead className="text-right">费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.categoryStats.map((row) => (
                <TableRow key={row.category ?? "uncategorized"}>
                  <TableCell>{row.category ?? "未分类"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.challenges}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.solved}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.points}
                    {row.pointsAvailable > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        / {row.pointsAvailable}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.attempts}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatTokens(row.tokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCost(row.cost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** Per-challenge ROI: score vs consumed cost/time/attempts. */
function ChallengeEfficiency({ data }: { data: EventStats }) {
  if (data.challengeEfficiency.length === 0) return null
  const rows = data.challengeEfficiency.toSorted((a, b) => {
    if (a.solved !== b.solved) return a.solved ? -1 : 1
    return roiOf(b) - roiOf(a)
  })
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>题目投入产出</CardFrameTitle>
        <CardFrameDescription>
          按性价比（分 / 美元）排序，已解题目在前
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>题目</TableHead>
                <TableHead className="text-right">分数</TableHead>
                <TableHead className="text-right">尝试</TableHead>
                <TableHead className="text-right">token</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead className="text-right">性价比</TableHead>
                <TableHead className="text-right">提交</TableHead>
                <TableHead className="text-right">消息</TableHead>
                <TableHead className="text-right">投入时长</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.challengeId}>
                  <TableCell className="max-w-56">
                    <span className="flex items-center gap-1.5">
                      {row.solved ? (
                        <Badge variant="secondary">已解</Badge>
                      ) : null}
                      <span className="truncate">{row.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.points ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.attempts}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatTokens(row.tokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCost(row.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {roiLabel(row)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.rejectedSubmissions > 0
                      ? `${row.submissions - row.rejectedSubmissions}/${row.submissions}`
                      : row.submissions}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.messages}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDurationClock(row.durationMs)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

function roiOf(row: EventChallengeEfficiency): number {
  if (row.cost <= 0) return row.points && row.points > 0 ? Infinity : 0
  return (row.points ?? 0) / row.cost
}

function roiLabel(row: EventChallengeEfficiency): string {
  const roi = roiOf(row)
  if (!Number.isFinite(roi)) return "∞"
  if (row.cost <= 0) return "—"
  return roi.toFixed(0)
}

/** Collaboration extras: channel-kind volume + hourly team messages + tool
 * TopN + failures (with the agents' last error) + flag submission accuracy. */
function CollaborationCards({ data }: { data: EventStats }) {
  const submissions = data.challengeEfficiency.reduce(
    (sum, row) => sum + row.submissions,
    0
  )
  const rejectedSubmissions = data.challengeEfficiency.reduce(
    (sum, row) => sum + row.rejectedSubmissions,
    0
  )
  const failureRows = data.agentEfficiency.filter(
    (row) => (row.status === "aborted" || row.status === "failed") && row.error
  )
  const kindsTotal =
    data.messageKinds.team + data.messageKinds.dm + data.messageKinds.orch
  if (
    data.messageActivity.length === 0 &&
    data.toolUsage.length === 0 &&
    data.failures.timeouts + data.failures.aborted + data.failures.failed ===
      0 &&
    submissions === 0 &&
    kindsTotal === 0
  ) {
    return null
  }
  const maxMessages = Math.max(...data.messageActivity.map((b) => b.count), 1)
  const maxCalls = Math.max(...data.toolUsage.map((t) => t.calls), 1)
  const toolCallsTotal =
    data.toolUsage.reduce((sum, tool) => sum + tool.calls, 0) || 1
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>协作与工具</CardFrameTitle>
        <CardFrameDescription>
          频道消息量、工具调用 TopN、提交准确率与异常结束
        </CardFrameDescription>
      </CardFrameHeader>
      <div className="grid gap-3 lg:grid-cols-2">
        {kindsTotal > 0 && (
          <Card>
            <CardPanel className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">#team 频道</p>
                <p className="font-semibold tabular-nums">
                  {data.messageKinds.team}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">dm 频道</p>
                <p className="font-semibold tabular-nums">
                  {data.messageKinds.dm}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">orch 频道</p>
                <p className="font-semibold tabular-nums">
                  {data.messageKinds.orch}
                </p>
              </div>
            </CardPanel>
          </Card>
        )}
        {data.messageActivity.length > 0 && (
          <Card>
            <CardPanel>
              <p className="mb-2 text-xs text-muted-foreground">
                #team 消息量（按小时）
              </p>
              <ResponsiveContainer height={160} width="100%">
                <BarChart
                  data={data.messageActivity}
                  margin={{ bottom: 0, left: 0, right: 0, top: 4 }}
                >
                  <CartesianGrid
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="bucket"
                    interval="equidistantPreserveStart"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(bucket) => formatTime(`${bucket}:00`)}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 10 }}
                    width={28}
                  />
                  <RechartsTooltip
                    {...chartTooltip}
                    cursor={{ fill: "var(--muted)", fillOpacity: 0.6 }}
                    formatter={(value) => [`${Number(value)} 条`, "消息"]}
                    labelFormatter={(bucket) =>
                      formatTime(
                        `${typeof bucket === "string" ? bucket : ""}:00`
                      )
                    }
                  />
                  <Bar dataKey="count" fill="var(--primary)" />
                </BarChart>
              </ResponsiveContainer>
              <p className="mt-1 text-2xs text-muted-foreground">
                峰值 {maxMessages} 条/小时
              </p>
            </CardPanel>
          </Card>
        )}
        {data.toolUsage.length > 0 && (
          <Card>
            <CardPanel className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                工具调用 Top{data.toolUsage.length}
              </p>
              {data.toolUsage.map((tool) => (
                <div className="flex items-center gap-2" key={tool.tool}>
                  <span className="w-28 shrink-0 truncate font-mono text-xs">
                    {tool.tool}
                  </span>
                  <div className="h-2 flex-1 rounded bg-muted/50">
                    <div
                      className="h-2 rounded bg-primary"
                      style={{ width: `${(tool.calls / maxCalls) * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
                    {tool.calls}
                    <span className="ml-1 text-muted-foreground">
                      {Math.round((tool.calls / toolCallsTotal) * 100)}%
                    </span>
                  </span>
                </div>
              ))}
            </CardPanel>
          </Card>
        )}
        <Card>
          <CardPanel className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap gap-x-8 gap-y-2">
              <div>
                <p className="text-xs text-muted-foreground">超时</p>
                <p className="font-semibold tabular-nums">
                  {data.failures.timeouts}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">中止</p>
                <p className="font-semibold tabular-nums">
                  {data.failures.aborted}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">失败</p>
                <p className="font-semibold tabular-nums">
                  {data.failures.failed}
                </p>
              </div>
              {submissions > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">flag 提交</p>
                  <p className="font-semibold tabular-nums">
                    {submissions - rejectedSubmissions}/{submissions}
                    {rejectedSubmissions > 0 && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {" "}
                        （拒绝 {rejectedSubmissions}）
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
            {failureRows.length > 0 && (
              <div className="flex flex-col gap-1 border-t pt-2">
                {failureRows.map((row) => (
                  <div className="flex items-baseline gap-2" key={row.id}>
                    <span className="shrink-0 text-xs font-medium">
                      {row.name ?? row.id}
                    </span>
                    <span
                      className="truncate text-xs text-destructive"
                      title={row.error ?? undefined}
                    >
                      {row.error}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardPanel>
        </Card>
      </div>
    </CardFrame>
  )
}

/** Compact HH:mm tick label (cross-day ticks fall back to the full format). */
function axisTickTime(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })
  }
  return formatTime(date.toISOString())
}
