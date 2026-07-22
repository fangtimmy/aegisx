import type { TooltipContentProps } from "recharts"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
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

export function SubmissionFunnelChart({
  funnel,
}: {
  funnel: EventStats["funnel"]
}) {
  const data = [
    {
      stage: "Total",
      count: funnel.totalChallenges,
      color: "var(--muted-foreground)",
    },
    {
      stage: "Attempted",
      count: funnel.attemptedChallenges,
      color: "var(--info)",
    },
    {
      stage: "Submitted",
      count: funnel.submittedChallenges,
      color: "var(--warning)",
    },
    {
      stage: "Solved",
      count: funnel.solvedChallenges,
      color: "var(--success)",
    },
  ]
  return (
    <ResponsiveContainer height={250} width="100%">
      <BarChart accessibilityLayer data={data} layout="vertical">
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis allowDecimals={false} tick={axisTick} type="number" />
        <YAxis
          dataKey="stage"
          tick={axisTick}
          tickLine={false}
          type="category"
          width={72}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--muted)" }}
          formatter={(value) => [formatNumber(Number(value)), "Challenges"]}
        />
        <Bar dataKey="count" radius={[0, 3, 3, 0]}>
          {data.map((item) => (
            <Cell fill={item.color} key={item.stage} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function FailureAttributionChart({
  failures,
}: {
  failures: EventStats["failures"]
}) {
  if (failures.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No unsuccessful terminal runs
      </p>
    )
  }
  return (
    <ResponsiveContainer
      height={Math.max(250, failures.length * 44)}
      width="100%"
    >
      <BarChart accessibilityLayer data={failures} layout="vertical">
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis allowDecimals={false} tick={axisTick} type="number" />
        <YAxis
          dataKey="reason"
          tick={axisTick}
          tickFormatter={shortLabel}
          tickLine={false}
          type="category"
          width={132}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--muted)" }}
          formatter={(value) => [formatNumber(Number(value)), "Runs"]}
        />
        <Bar
          dataKey="runCount"
          fill="var(--destructive)"
          radius={[0, 3, 3, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

type ModelPoint = {
  averageDurationMs: number
  averageDurationMinutes: number
  averageTokens: number
  key: string
  label: string
  knownCost: number
  runCount: number
  successRate: number | null
}

function ModelTooltip({ active, payload }: TooltipContentProps) {
  const point = payload?.[0]?.payload as ModelPoint | undefined
  if (!active || !point) return null
  return (
    <div className="max-w-72 rounded-lg border bg-popover px-3 py-2 text-popover-foreground text-xs shadow-lg">
      <p className="truncate font-medium">{point.label}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>Runs</dt>
        <dd className="text-right tabular-nums">{point.runCount}</dd>
        <dt>Success</dt>
        <dd className="text-right tabular-nums">
          {point.successRate === null
            ? "-"
            : `${(point.successRate * 100).toFixed(1)}%`}
        </dd>
        <dt>Avg tokens</dt>
        <dd className="text-right tabular-nums">
          {formatNumber(point.averageTokens)}
        </dd>
        <dt>Avg duration</dt>
        <dd className="text-right tabular-nums">
          {formatDuration(point.averageDurationMs)}
        </dd>
        <dt>Known cost</dt>
        <dd className="text-right tabular-nums">
          {formatCost(point.knownCost)}
        </dd>
      </dl>
    </div>
  )
}

export function ModelComparisonChart({
  models,
}: {
  models: EventStats["models"]
}) {
  const data = models.flatMap((model): ModelPoint[] =>
    model.averageDurationMs === null
      ? []
      : [
          {
            averageDurationMs: model.averageDurationMs,
            averageDurationMinutes: model.averageDurationMs / 60_000,
            averageTokens: model.averageTokens,
            key: model.key,
            label: `${model.provider} / ${model.modelName}`,
            knownCost: model.cost.known,
            runCount: model.runCount,
            successRate: model.successRate,
          },
        ]
  )
  if (data.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No terminal model data
      </p>
    )
  }
  return (
    <ResponsiveContainer height={340} width="100%">
      <ScatterChart
        accessibilityLayer
        margin={{ bottom: 8, left: 8, right: 20, top: 8 }}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="averageDurationMinutes"
          name="Average duration"
          tick={axisTick}
          tickFormatter={(value) => `${Number(value).toFixed(0)}m`}
          type="number"
        />
        <YAxis
          dataKey="averageTokens"
          name="Average tokens"
          tick={axisTick}
          tickFormatter={(value) => formatCompactNumber(Number(value))}
          type="number"
        />
        <ZAxis dataKey="runCount" range={[80, 520]} type="number" />
        <Tooltip content={ModelTooltip} cursor={{ strokeDasharray: "3 3" }} />
        <Scatter data={data} name="Models">
          {data.map((item) => (
            <Cell
              fill={
                item.successRate === null
                  ? "var(--muted-foreground)"
                  : item.successRate >= 0.8
                    ? "var(--success)"
                    : item.successRate >= 0.5
                      ? "var(--warning)"
                      : "var(--destructive)"
              }
              key={item.key}
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}

export function TokenCompositionChart({
  usage,
}: {
  usage: EventStats["usage"]
}) {
  const data = [
    {
      name: "Tokens",
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
  ]
  return (
    <ResponsiveContainer height={190} width="100%">
      <BarChart accessibilityLayer data={data} layout="vertical">
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis
          tick={axisTick}
          tickFormatter={(value) => formatCompactNumber(Number(value))}
          type="number"
        />
        <YAxis dataKey="name" hide type="category" />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, name) => [
            formatNumber(Number(value)),
            String(name),
          ]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="input" fill="var(--info)" name="Input" stackId="tokens" />
        <Bar
          dataKey="output"
          fill="var(--success)"
          name="Output"
          stackId="tokens"
        />
        <Bar
          dataKey="cacheRead"
          fill="var(--warning)"
          name="Cache read"
          stackId="tokens"
        />
        <Bar
          dataKey="cacheWrite"
          fill="var(--muted-foreground)"
          name="Cache write"
          radius={[0, 3, 3, 0]}
          stackId="tokens"
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function PerformanceTrendChart({
  trend,
}: {
  trend: EventStats["trend"]
}) {
  const data = trend.map((item) => ({
    ...item,
    successPercent: item.successRate === null ? null : item.successRate * 100,
  }))
  if (data.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground text-sm">
        No trend data
      </p>
    )
  }
  return (
    <ResponsiveContainer height={300} width="100%">
      <ComposedChart
        accessibilityLayer
        data={data}
        margin={{ left: 4, right: 12, top: 8 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="date" tick={axisTick} tickLine={false} />
        <YAxis
          tick={axisTick}
          tickFormatter={(value) => formatCompactNumber(Number(value))}
          yAxisId="tokens"
        />
        <YAxis
          domain={[0, 100]}
          orientation="right"
          tick={axisTick}
          tickFormatter={(value) => `${value}%`}
          yAxisId="success"
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, name) => [
            name === "Success rate"
              ? `${Number(value).toFixed(1)}%`
              : formatNumber(Number(value)),
            String(name),
          ]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar
          dataKey="totalTokens"
          fill="var(--info)"
          name="Tokens"
          radius={[3, 3, 0, 0]}
          yAxisId="tokens"
        />
        <Line
          connectNulls
          dataKey="successPercent"
          dot={{ r: 3 }}
          name="Success rate"
          stroke="var(--success)"
          strokeWidth={2}
          type="monotone"
          yAxisId="success"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
