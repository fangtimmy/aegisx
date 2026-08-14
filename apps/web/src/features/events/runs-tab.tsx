import { Flag } from "lucide-react"
import { Link } from "react-router"

import type { RunPublic } from "@/api"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { runStatusLabel, statusVariant } from "@/features/runs/run-overview"
import { formatTime } from "@/lib/format"

export function RunsTab({ runs }: { runs: RunPublic[] }) {
  const activeRuns = runs
    .filter((run) => run.status !== "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const historyRuns = runs
    .filter((run) => run.status === "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-4 p-1">
        <section>
          <div className="flex items-center gap-2 p-1">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              活跃任务
            </h3>
            <Badge size="sm" variant="secondary">
              {activeRuns.length}
            </Badge>
          </div>
          {activeRuns.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              暂无活跃任务。
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {activeRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </section>
        {historyRuns.length > 0 && (
          <section>
            <div className="flex items-center gap-2 p-1">
              <h3 className="text-xs font-medium text-muted-foreground uppercase">
                已归档
              </h3>
              <Badge size="sm" variant="secondary">
                {historyRuns.length}
              </Badge>
            </div>
            <div className="flex flex-col gap-1">
              {historyRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}

function RunRow({ run }: { run: RunPublic }) {
  return (
    <Link
      className="group flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2.5 hover:bg-accent"
      to={`/events/${run.eventId}/runs/${run.id}`}
    >
      <span className="shrink-0">
        <Badge size="sm" variant={statusVariant(run.status)}>
          {runStatusLabel(run.status)}
        </Badge>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {run.challengeName}
          </span>
          {run.hasAcceptedFlag && (
            <Badge size="sm" variant="success">
              <Flag />
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
          {run.provider} / {run.modelName}
        </span>
      </span>
      <time
        className="shrink-0 text-xs text-muted-foreground"
        dateTime={run.updatedAt}
        title={new Date(run.updatedAt).toLocaleString()}
      >
        {formatTime(run.updatedAt)}
      </time>
    </Link>
  )
}
