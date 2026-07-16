import { Box, CircleAlert, Monitor } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type {
  AgentStatus,
  AgentSummary,
  RunPublic,
  UsageSummary,
} from "@/lib/api"
import { formatTime } from "./timeline"

export function statusVariant(status: AgentStatus) {
  if (status === "completed") return "success" as const
  if (status === "failed") return "error" as const
  if (status === "paused") return "warning" as const
  return "secondary" as const
}

export function RunOverview({
  agents,
  run,
  stats,
}: {
  agents: AgentSummary[]
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
        <h3 className="mb-3 font-medium text-sm">Agent token usage</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cache read</TableHead>
              <TableHead className="text-right">Cache write</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((agent) => (
              <TableRow key={agent.id}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell>
                  {agent.parentAgentId === null ? "Main" : "Child"}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(agent.status)}>
                    {agent.status}
                  </Badge>
                </TableCell>
                <UsageCells usage={agent.usage} />
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium" colSpan={3}>
                Run total
              </TableCell>
              <UsageCells usage={stats} />
            </TableRow>
          </TableFooter>
        </Table>
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

function UsageCells({ usage }: { usage: UsageSummary }) {
  return (
    <>
      {[
        ["input", usage.input],
        ["output", usage.output],
        ["cache-read", usage.cacheRead],
        ["cache-write", usage.cacheWrite],
        ["total", usage.totalTokens],
      ].map(([key, value]) => (
        <TableCell
          className="text-right font-mono text-xs tabular-nums"
          key={key}
        >
          {value.toLocaleString()}
        </TableCell>
      ))}
    </>
  )
}
