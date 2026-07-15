import { useQuery } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { apiRequest, type EventStats, type UsageSummary } from "@/lib/api"

function number(value: number) {
  return new Intl.NumberFormat().format(value)
}

function cost(value: number | null) {
  return value === null
    ? "Unknown"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(value)
}

function UsageMetrics({ usage }: { usage: UsageSummary }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y py-5 sm:grid-cols-3 lg:grid-cols-6">
      {[
        ["Input", number(usage.input)],
        ["Output", number(usage.output)],
        ["Cache read", number(usage.cacheRead)],
        ["Cache write", number(usage.cacheWrite)],
        ["Total tokens", number(usage.totalTokens)],
        ["Cost", cost(usage.cost)],
      ].map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <dd className="mt-1 font-medium tabular-nums text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function EventStatistics({ eventId }: { eventId: string }) {
  const query = useQuery({
    queryKey: ["events", eventId, "statistics"],
    queryFn: () => apiRequest<EventStats>(`/events/${eventId}/stats`),
  })

  if (query.isPending) {
    return (
      <p className="py-16 text-center text-muted-foreground text-sm">
        Loading statistics...
      </p>
    )
  }
  if (query.error) {
    return (
      <Alert className="rounded-lg" variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load statistics</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    )
  }

  const stats = query.data
  const largest = Math.max(
    1,
    ...stats.challenges.map((item) => item.usage.totalTokens)
  )

  return (
    <div className="space-y-8">
      <section aria-labelledby="usage-summary">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="font-semibold text-base" id="usage-summary">
            Usage summary
          </h2>
          <span className="text-muted-foreground text-sm">
            {number(stats.runCount)} runs
          </span>
        </div>
        <UsageMetrics usage={stats.usage} />
      </section>

      <section aria-labelledby="challenge-usage">
        <h2 className="font-semibold text-base" id="challenge-usage">
          Usage by challenge
        </h2>
        <div className="mt-4 space-y-4">
          {stats.challenges.length === 0 && (
            <p className="text-muted-foreground text-sm">No usage recorded.</p>
          )}
          {stats.challenges.map((item) => (
            <div key={item.challengeId}>
              <div className="mb-1.5 flex min-w-0 items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">
                  {item.challengeName}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground text-xs">
                  {number(item.usage.totalTokens)} tokens / {item.runCount} runs
                </span>
              </div>
              <div
                aria-label={`${item.challengeName}: ${number(item.usage.totalTokens)} tokens`}
                className="h-2 overflow-hidden rounded-sm bg-muted"
                role="img"
              >
                <div
                  className="h-full bg-foreground/70"
                  style={{
                    width: `${(item.usage.totalTokens / largest) * 100}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="run-usage">
        <h2 className="font-semibold text-base" id="run-usage">
          Run details
        </h2>
        <Table className="mt-3 min-w-[920px]">
          <TableHeader>
            <TableRow>
              <TableHead>Challenge</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cache read</TableHead>
              <TableHead className="text-right">Cache write</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.runs.map(({ run, usage }) => (
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
                  {run.provider} / {run.modelId}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{run.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(usage.input)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(usage.output)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(usage.cacheRead)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(usage.cacheWrite)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(usage.totalTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {cost(usage.cost)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}
