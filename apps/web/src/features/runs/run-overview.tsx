import { Box, CircleAlert, Monitor } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import type { RunPublic, RunStatus, UsageSummary } from "@/lib/api"
import { formatTime } from "./timeline"

export function statusVariant(status: RunStatus) {
  if (status === "completed") return "success" as const
  if (status === "failed") return "error" as const
  if (status === "paused") return "warning" as const
  return "secondary" as const
}

export function RunOverview({
  run,
  stats,
}: {
  run: RunPublic
  stats: UsageSummary
}) {
  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {run.environment === "local" ? (
        <Alert variant="warning">
          <Monitor />
          <AlertTitle>Local environment</AlertTitle>
          <AlertDescription>
            This run is executing without a sandbox. Local files and processes
            may be accessible to the agent.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <Box />
          <AlertTitle>Container environment</AlertTitle>
          <AlertDescription>
            This run is isolated in a container with its workspace at
            /workspace.
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs">Status</dt>
          <dd className="mt-1">
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Model</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {run.provider} / {run.modelId}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Environment</dt>
          <dd className="mt-1 capitalize">{run.environment}</dd>
        </div>
        {run.environment === "container" && (
          <div>
            <dt className="text-muted-foreground text-xs">Image</dt>
            <dd className="mt-1 break-all font-mono text-xs">
              {run.image || "Not available"}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground text-xs">Started</dt>
          <dd className="mt-1">{formatTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Completed</dt>
          <dd className="mt-1">{formatTime(run.completedAt)}</dd>
        </div>
      </dl>
      <section className="border-t pt-4">
        <h3 className="font-medium text-sm">Token usage</h3>
        <dl className="mt-3 grid grid-cols-3 gap-x-8 gap-y-4 text-sm">
          {[
            ["Input", stats.input.toLocaleString()],
            ["Output", stats.output.toLocaleString()],
            ["Cache read", stats.cacheRead.toLocaleString()],
            ["Cache write", stats.cacheWrite.toLocaleString()],
            ["Total tokens", stats.totalTokens.toLocaleString()],
            [
              "Cost",
              stats.cost === null
                ? "Unknown"
                : new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 6,
                  }).format(stats.cost),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className="mt-1 font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {(run.summary || run.flag) && (
        <section className="border-t pt-4">
          <h3 className="font-medium text-sm">Result</h3>
          {run.summary && (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
              {run.summary}
            </p>
          )}
          {run.flag && (
            <p className="mt-2 break-all font-mono text-xs">Flag: {run.flag}</p>
          )}
        </section>
      )}
      {run.error && (
        <Alert variant="error">
          <CircleAlert />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {run.error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
