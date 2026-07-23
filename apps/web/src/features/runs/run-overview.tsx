import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Box,
  CircleAlert,
  Clock3,
  Monitor,
  Play,
  RefreshCw,
  Square,
} from "lucide-react"
import type { AgentStatus, AgentSummary, RunPublic, UsageSummary } from "@/api"
import { challengesApi, keys } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/lib/toast"
import { formatTime } from "./timeline"

export function statusVariant(status: AgentStatus) {
  if (status === "running") return "info" as const
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
      {run.targetSupported && <TargetPanel run={run} />}
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
            {run.provider} / {run.modelName}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Reasoning</dt>
          <dd className="mt-1 capitalize">{run.thinkingLevel}</dd>
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

function TargetPanel({ run }: { run: RunPublic }) {
  const queryClient = useQueryClient()
  const key = keys.challenges.target(run.challengeId)
  const target = useQuery({
    queryKey: key,
    queryFn: () => challengesApi.getTarget(run.challengeId),
  })
  const action = useMutation({
    mutationFn: (value: "start" | "extend" | "stop") =>
      challengesApi.targetAction(run.challengeId, value),
    onSuccess: (_value, variables) => {
      queryClient.setQueryData(key, _value)
      const verb =
        variables === "start"
          ? "started"
          : variables === "stop"
            ? "stopped"
            : "extended"
      toast.success(`Target ${verb}`)
    },
    onError: (error) => toast.error("Target action failed", error.message),
  })
  const value = target.data

  return (
    <section className="border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-medium text-sm">Challenge target</h3>
        <Badge variant={value?.status === "running" ? "success" : "secondary"}>
          {value?.status ?? "loading"}
        </Badge>
        <Button
          aria-label="Refresh target"
          loading={target.isFetching}
          onClick={() => target.refetch()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw />
        </Button>
        {value?.status === "absent" && (
          <Button
            loading={action.isPending}
            onClick={() => action.mutate("start")}
            type="button"
            variant="outline"
          >
            <Play /> Start
          </Button>
        )}
        {value?.status === "running" && (
          <>
            <Button
              loading={action.isPending && action.variables === "extend"}
              onClick={() => action.mutate("extend")}
              type="button"
              variant="outline"
            >
              <Clock3 /> Extend
            </Button>
            <Button
              loading={action.isPending && action.variables === "stop"}
              onClick={() => action.mutate("stop")}
              type="button"
              variant="destructive-outline"
            >
              <Square /> Stop
            </Button>
          </>
        )}
      </div>
      {value && value.endpoints.length > 0 && (
        <div className="mt-3 grid gap-2">
          {value.endpoints.map((endpoint) => (
            <div
              className="flex min-w-0 items-center justify-between gap-3 text-sm"
              key={`${endpoint.name}:${endpoint.address}`}
            >
              <span className="text-muted-foreground">{endpoint.name}</span>
              <code className="truncate text-xs">{endpoint.address}</code>
            </div>
          ))}
        </div>
      )}
      {value?.expiresAt && (
        <p className="mt-2 text-muted-foreground text-xs">
          Expires {formatTime(value.expiresAt)}
        </p>
      )}
      {(target.error || action.error) && (
        <p className="mt-2 text-destructive text-xs">
          {(target.error ?? action.error)?.message}
        </p>
      )}
    </section>
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
