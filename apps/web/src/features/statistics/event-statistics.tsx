import { useQuery } from "@tanstack/react-query"
import { ChartNoAxesColumn, CircleAlert } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { apiRequest, type EventStats } from "@/lib/api"
import {
  FailureAttributionChart,
  ModelComparisonChart,
  PerformanceTrendChart,
  SubmissionFunnelChart,
  TokenCompositionChart,
} from "./event-statistics-analysis-charts"
import {
  CategoryCoverageChart,
  ChallengeCostChart,
  RunEfficiencyChart,
  ToolReliabilityChart,
} from "./event-statistics-charts"
import {
  formatCompactNumber,
  formatCost,
  formatDuration,
  formatNumber,
} from "./statistics-format"

function Metric({
  description,
  label,
  value,
}: {
  description: string
  label: string
  value: string
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums text-xl">{value}</dd>
      <dd className="mt-1 text-muted-foreground text-xs">{description}</dd>
    </div>
  )
}

export function EventStatistics({ eventId }: { eventId: string }) {
  const [runFilter, setRunFilter] = useState("all")
  const [runSort, setRunSort] = useState("recent")
  const query = useQuery({
    queryKey: ["events", eventId, "statistics", 3],
    queryFn: () => apiRequest<EventStats>(`/events/${eventId}/stats`),
  })

  if (query.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" />
        Loading statistics...
      </div>
    )
  }
  if (query.error) {
    return (
      <Alert variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load statistics</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    )
  }

  const stats = query.data
  const challengeRows = stats.challenges.filter((item) => item.runCount > 0)
  const runRows = stats.runs
    .filter((item) => {
      if (runFilter === "successful") return item.successful
      if (runFilter === "unsuccessful") {
        return (
          !item.successful &&
          ["completed", "failed", "stopped"].includes(item.run.status)
        )
      }
      if (runFilter === "active") {
        return ["running", "paused"].includes(item.run.status)
      }
      return true
    })
    .toSorted((a, b) => {
      if (runSort === "tokens") return b.usage.totalTokens - a.usage.totalTokens
      if (runSort === "duration")
        return (b.durationMs ?? -1) - (a.durationMs ?? -1)
      if (runSort === "cost") return (b.usage.cost ?? -1) - (a.usage.cost ?? -1)
      return b.run.createdAt.localeCompare(a.run.createdAt)
    })
  const successPercent =
    stats.successRate === null
      ? "-"
      : `${(stats.successRate * 100).toFixed(1)}%`
  const unknownCost = stats.cost.unknownRunCount
    ? `${stats.cost.unknownRunCount} runs unknown`
    : "All runs priced"
  const firstAttemptRate =
    stats.funnel.submittedRuns === 0
      ? "-"
      : `${(
          (stats.funnel.firstAttemptAcceptedRuns / stats.funnel.submittedRuns) *
            100
        ).toFixed(1)}%`

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="performance-overview">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="font-semibold text-base" id="performance-overview">
            Performance overview
          </h2>
          <span className="text-muted-foreground text-sm">
            {formatNumber(stats.runCount)} runs
          </span>
        </div>
        <dl className="grid grid-cols-6 gap-6 border-y py-5">
          <Metric
            description={`${stats.challengeCount} total challenges`}
            label="Agent solved"
            value={`${stats.solvedChallengeCount} / ${stats.attemptedChallengeCount}`}
          />
          <Metric
            description={`${stats.successfulRunCount} / ${stats.terminalRunCount} terminal runs`}
            label="Run success"
            value={successPercent}
          />
          <Metric
            description={`${formatCompactNumber(stats.usage.cacheRead)} cache read`}
            label="Total tokens"
            value={formatCompactNumber(stats.usage.totalTokens)}
          />
          <Metric
            description={unknownCost}
            label="Known cost"
            value={formatCost(stats.cost.known)}
          />
          <Metric
            description="Terminal runs"
            label="Median duration"
            value={formatDuration(stats.duration.medianMs)}
          />
          <Metric
            description="Slowest decile threshold"
            label="P90 duration"
            value={formatDuration(stats.duration.p90Ms)}
          />
        </dl>
      </section>

      <section aria-labelledby="outcome-comparison">
        <h2 className="font-semibold text-base" id="outcome-comparison">
          Outcome efficiency
        </h2>
        <div className="mt-4 grid grid-cols-2 border-y divide-x">
          {stats.outcomes.map((outcome) => (
            <div
              className="grid grid-cols-3 gap-6 px-5 py-4"
              key={outcome.outcome}
            >
              <div>
                <p className="font-medium text-sm capitalize">
                  {outcome.outcome}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {outcome.runCount} terminal runs
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Avg tokens</p>
                <p className="mt-1 font-medium tabular-nums text-sm">
                  {formatCompactNumber(outcome.averageTokens)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Avg duration</p>
                <p className="mt-1 font-medium tabular-nums text-sm">
                  {formatDuration(outcome.averageDurationMs)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-x-8">
        <section className="border-t pt-5" aria-labelledby="submission-funnel">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h2 className="font-semibold text-base" id="submission-funnel">
                Challenge funnel
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                Coverage from available challenges to accepted solutions
              </p>
            </div>
            <div className="text-right">
              <p className="font-medium tabular-nums text-sm">
                {firstAttemptRate} first attempt
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {stats.funnel.acceptedSubmissions} accepted /{" "}
                {stats.funnel.rejectedSubmissions} rejected
              </p>
            </div>
          </div>
          <div className="mt-3">
            <SubmissionFunnelChart funnel={stats.funnel} />
          </div>
        </section>

        <section
          className="border-t pt-5"
          aria-labelledby="failure-attribution"
        >
          <h2 className="font-semibold text-base" id="failure-attribution">
            Failure attribution
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Mutually exclusive outcomes for unsuccessful terminal runs
          </p>
          <div className="mt-3">
            <FailureAttributionChart failures={stats.failures} />
          </div>
        </section>
      </div>

      <section className="border-t pt-6" aria-labelledby="model-comparison">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-semibold text-base" id="model-comparison">
              Model comparison
            </h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Bubble size represents run count; low-sample models remain visible
            </p>
          </div>
          <span className="text-muted-foreground text-xs">
            {stats.models.length} models
          </span>
        </div>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(520px,1.2fr)] gap-8">
          <ModelComparisonChart models={stats.models} />
          <Table className="min-w-[600px]" variant="card">
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Success</TableHead>
                <TableHead className="text-right">Avg tokens</TableHead>
                <TableHead className="text-right">Avg duration</TableHead>
                <TableHead className="text-right">Cost / solve</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.models.map((model) => (
                <TableRow key={model.key}>
                  <TableCell>
                    <p className="font-medium">{model.modelName}</p>
                    <div className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
                      <span>{model.provider}</span>
                      {model.runCount < 5 && (
                        <Badge size="sm" variant="warning">
                          Low sample
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {model.runCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {model.successRate === null
                      ? "-"
                      : `${(model.successRate * 100).toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCompactNumber(model.averageTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(model.averageDurationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {model.successfulRunCount === 0
                      ? "-"
                      : `${model.cost.unknownRunCount > 0 ? "At least " : ""}${formatCost(
                          model.cost.known / model.successfulRunCount
                        )}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-x-8">
        <section className="border-t pt-5" aria-labelledby="token-composition">
          <h2 className="font-semibold text-base" id="token-composition">
            Token composition
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Input, output and provider cache contribution
          </p>
          <div className="mt-3">
            <TokenCompositionChart usage={stats.usage} />
          </div>
        </section>

        <section className="border-t pt-5" aria-labelledby="performance-trend">
          <h2 className="font-semibold text-base" id="performance-trend">
            Performance trend
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Daily token consumption and terminal success rate
          </p>
          <div className="mt-3">
            <PerformanceTrendChart trend={stats.trend} />
          </div>
        </section>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-10">
        <section className="border-t pt-5" aria-labelledby="category-coverage">
          <h2 className="font-semibold text-base" id="category-coverage">
            Category coverage
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Challenge coverage by Agent outcome
          </p>
          <div className="mt-3">
            <CategoryCoverageChart categories={stats.categories} />
          </div>
        </section>

        <section className="border-t pt-5" aria-labelledby="run-efficiency">
          <h2 className="font-semibold text-base" id="run-efficiency">
            Run efficiency
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Token consumption against terminal run duration
          </p>
          <div className="mt-3">
            <RunEfficiencyChart runs={stats.runs} />
          </div>
        </section>

        <section className="border-t pt-5" aria-labelledby="challenge-cost">
          <h2 className="font-semibold text-base" id="challenge-cost">
            Highest challenge cost
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Top ten challenges by known provider cost
          </p>
          <div className="mt-3">
            <ChallengeCostChart challenges={stats.challenges} />
          </div>
        </section>

        <section className="border-t pt-5" aria-labelledby="tool-reliability">
          <h2 className="font-semibold text-base" id="tool-reliability">
            Tool reliability
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Most-used tools with observed failure rate
          </p>
          <div className="mt-3">
            <ToolReliabilityChart tools={stats.tools} />
          </div>
        </section>
      </div>

      <section className="border-t pt-6" aria-labelledby="challenge-usage">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-semibold text-base" id="challenge-usage">
            Challenge efficiency
          </h2>
          <span className="text-muted-foreground text-xs">
            {challengeRows.length} attempted
          </span>
        </div>
        {challengeRows.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartNoAxesColumn />
              </EmptyMedia>
              <EmptyTitle>No usage recorded</EmptyTitle>
              <EmptyDescription>
                Usage appears after the first run starts.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className="mt-3 min-w-[880px]" variant="card">
            <TableHeader>
              <TableRow>
                <TableHead>Challenge</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Avg tokens</TableHead>
                <TableHead className="text-right">Median</TableHead>
                <TableHead className="text-right">Known cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {challengeRows.map((item) => (
                <TableRow key={item.challengeId}>
                  <TableCell className="max-w-72 truncate font-medium">
                    {item.challengeName}
                  </TableCell>
                  <TableCell>{item.category ?? "Uncategorized"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        item.successfulRunCount > 0 ? "success" : "warning"
                      }
                    >
                      {item.successfulRunCount > 0 ? "Solved" : "Unsuccessful"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.runCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCompactNumber(
                      Math.round(item.usage.totalTokens / item.runCount)
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(item.duration.medianMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCost(item.cost.known)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="border-t pt-6" aria-labelledby="run-usage">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-base" id="run-usage">
              Run details
            </h2>
            <p className="mt-1 text-muted-foreground text-xs">
              {runRows.length} of {stats.runCount} runs
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              items={{
                all: "All outcomes",
                successful: "Successful",
                unsuccessful: "Unsuccessful",
                active: "Active",
              }}
              onValueChange={(value) => setRunFilter(value ?? "all")}
              value={runFilter}
            >
              <SelectTrigger className="w-36" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="successful">Successful</SelectItem>
                <SelectItem value="unsuccessful">Unsuccessful</SelectItem>
                <SelectItem value="active">Active</SelectItem>
              </SelectPopup>
            </Select>
            <Select
              items={{
                recent: "Most recent",
                tokens: "Highest tokens",
                duration: "Longest duration",
                cost: "Highest cost",
              }}
              onValueChange={(value) => setRunSort(value ?? "recent")}
              value={runSort}
            >
              <SelectTrigger className="w-40" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="recent">Most recent</SelectItem>
                <SelectItem value="tokens">Highest tokens</SelectItem>
                <SelectItem value="duration">Longest duration</SelectItem>
                <SelectItem value="cost">Highest cost</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </div>
        {runRows.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No matching runs</EmptyTitle>
              <EmptyDescription>
                Change the outcome filter to view other runs.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className="mt-3 min-w-[900px]" variant="card">
            <TableHeader>
              <TableRow>
                <TableHead>Challenge</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runRows.map(({ durationMs, run, successful, usage }) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      to={`/events/${eventId}/runs/${run.id}?view=overview`}
                    >
                      {run.challengeName}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {run.provider} / {run.modelName}
                  </TableCell>
                  <TableCell>
                    <Badge variant={successful ? "success" : "secondary"}>
                      {successful ? "solved" : run.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(durationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(usage.totalTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usage.cost === null ? "Unknown" : formatCost(usage.cost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}
