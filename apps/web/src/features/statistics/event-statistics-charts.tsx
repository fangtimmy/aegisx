import type { TooltipContentProps } from "recharts"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { EventStats } from "@/lib/api"
import {
  formatCompactNumber,
  formatCost,
  formatDuration,
  formatNumber,
} from "./statistics-format"

const tooltipStyle = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--popover-foreground)",
  fontSize: 12,
}
const axisTick = { fill: "var(--muted-foreground)", fontSize: 11 }
const shortLabel = (value: string) =>
  value.length > 18 ? `${value.slice(0, 17)}...` : value

export function CategoryCoverageChart({
  categories,
}: {
  categories: EventStats["categories"]
}) {
  const data = categories.map((item) => ({
    category: item.category,
    solved: item.solvedCount,
    unsuccessful: item.attemptedCount - item.solvedCount,
    unattempted: item.challengeCount - item.attemptedCount,
  }))
  if (data.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No challenges recorded
      </p>
    )
  }
  return (
    <ResponsiveContainer height={Math.max(240, data.length * 44)} width="100%">
      <BarChart
        accessibilityLayer
        data={data}
        layout="vertical"
        margin={{ left: 8, right: 16 }}
      >
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis allowDecimals={false} tick={axisTick} type="number" />
        <YAxis
          dataKey="category"
          tick={axisTick}
          tickFormatter={shortLabel}
          tickLine={false}
          type="category"
          width={128}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--muted)" }}
          formatter={(value, name) => [
            formatNumber(Number(value)),
            String(name),
          ]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar
          dataKey="solved"
          fill="var(--success)"
          name="Solved"
          stackId="coverage"
        />
        <Bar
          dataKey="unsuccessful"
          fill="var(--warning)"
          name="Attempted"
          stackId="coverage"
        />
        <Bar
          dataKey="unattempted"
          fill="var(--muted-foreground)"
          fillOpacity={0.28}
          name="Not attempted"
          radius={[0, 3, 3, 0]}
          stackId="coverage"
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

type RunPoint = {
  challenge: string
  durationMs: number
  durationMinutes: number
  runId: string
  tokens: number
  cost: number | null
}

function RunTooltip({ active, payload }: TooltipContentProps) {
  const point = payload?.[0]?.payload as RunPoint | undefined
  if (!active || !point) return null
  return (
    <div className="max-w-64 rounded-lg border bg-popover px-3 py-2 text-popover-foreground text-xs shadow-lg">
      <p className="truncate font-medium">{point.challenge}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>Tokens</dt>
        <dd className="text-right tabular-nums">
          {formatNumber(point.tokens)}
        </dd>
        <dt>Duration</dt>
        <dd className="text-right tabular-nums">
          {formatDuration(point.durationMs)}
        </dd>
        <dt>Cost</dt>
        <dd className="text-right tabular-nums">
          {point.cost === null ? "Unknown" : formatCost(point.cost)}
        </dd>
      </dl>
    </div>
  )
}

export function RunEfficiencyChart({ runs }: { runs: EventStats["runs"] }) {
  const points = runs.flatMap((item): RunPoint[] =>
    item.durationMs === null || item.usage.totalTokens === 0
      ? []
      : [
          {
            challenge: item.run.challengeName,
            durationMs: item.durationMs,
            durationMinutes: item.durationMs / 60_000,
            runId: item.run.id,
            tokens: item.usage.totalTokens,
            cost: item.usage.cost,
          },
        ]
  )
  const successfulIds = new Set(
    runs.filter((item) => item.successful).map((item) => item.run.id)
  )
  const successful = points.filter((point) => successfulIds.has(point.runId))
  const unsuccessful = points.filter((point) => !successfulIds.has(point.runId))
  if (points.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No terminal run usage recorded
      </p>
    )
  }

  return (
    <ResponsiveContainer height={320} width="100%">
      <ScatterChart
        accessibilityLayer
        margin={{ bottom: 8, left: 8, right: 16, top: 8 }}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="durationMinutes"
          name="Duration"
          tick={axisTick}
          tickFormatter={(value) => `${Number(value).toFixed(0)}m`}
          type="number"
          unit=" min"
        />
        <YAxis
          dataKey="tokens"
          name="Tokens"
          tick={axisTick}
          tickFormatter={(value) => formatCompactNumber(Number(value))}
          type="number"
        />
        <Tooltip content={RunTooltip} cursor={{ strokeDasharray: "3 3" }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Scatter data={successful} fill="var(--success)" name="Successful" />
        <Scatter
          data={unsuccessful}
          fill="var(--destructive)"
          name="Unsuccessful"
        />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

export function ChallengeCostChart({
  challenges,
}: {
  challenges: EventStats["challenges"]
}) {
  const data = challenges
    .filter((item) => item.cost.known > 0)
    .toSorted((a, b) => b.cost.known - a.cost.known)
    .slice(0, 10)
    .map((item) => ({
      challenge: item.challengeName,
      cost: item.cost.known,
    }))
  if (data.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No known cost data
      </p>
    )
  }
  return (
    <ResponsiveContainer height={Math.max(280, data.length * 34)} width="100%">
      <BarChart
        accessibilityLayer
        data={data}
        layout="vertical"
        margin={{ left: 8, right: 24 }}
      >
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis
          tick={axisTick}
          tickFormatter={(value) => formatCost(Number(value))}
          type="number"
        />
        <YAxis
          dataKey="challenge"
          tick={axisTick}
          tickFormatter={shortLabel}
          tickLine={false}
          type="category"
          width={140}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--muted)" }}
          formatter={(value) => [formatCost(Number(value)), "Known cost"]}
        />
        <Bar dataKey="cost" fill="var(--info)" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ToolReliabilityChart({
  tools,
}: {
  tools: EventStats["tools"]
}) {
  const data = tools.slice(0, 8).map((item) => ({
    tool: item.toolName,
    calls: item.callCount,
    failureRate:
      item.callCount === 0 ? 0 : (item.failedCount / item.callCount) * 100,
  }))
  if (data.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No tool calls recorded
      </p>
    )
  }
  return (
    <ResponsiveContainer height={320} width="100%">
      <ComposedChart
        accessibilityLayer
        data={data}
        margin={{ left: 4, right: 12, top: 8 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="tool" tick={axisTick} tickLine={false} />
        <YAxis
          allowDecimals={false}
          tick={axisTick}
          tickFormatter={(value) => formatCompactNumber(Number(value))}
          yAxisId="calls"
        />
        <YAxis
          domain={[0, 100]}
          orientation="right"
          tick={axisTick}
          tickFormatter={(value) => `${value}%`}
          yAxisId="rate"
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, name) => [
            name === "Failure rate"
              ? `${Number(value).toFixed(1)}%`
              : formatNumber(Number(value)),
            String(name),
          ]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar
          dataKey="calls"
          fill="var(--info)"
          name="Calls"
          radius={[3, 3, 0, 0]}
          yAxisId="calls"
        />
        <Line
          dataKey="failureRate"
          dot={{ r: 3 }}
          name="Failure rate"
          stroke="var(--destructive)"
          strokeWidth={2}
          type="monotone"
          yAxisId="rate"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
