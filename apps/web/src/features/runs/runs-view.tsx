import { useQuery } from "@tanstack/react-query"
import { ArrowUpDown, CircleAlert, Flag, List, Plus } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import type { Challenge, RunPublic } from "@/lib/api"
import { apiRequest } from "@/lib/api"
import { AgentStatusIcon } from "./agent-status-icon"
import { CreateRunDialog } from "./create-run-dialog"
import { statusVariant } from "./run-overview"
import { RunWorkspace } from "./run-workspace"

const runTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

function RunItem({
  eventId,
  run,
  runId,
}: {
  eventId: string
  run: RunPublic
  runId?: string
}) {
  return (
    <Button
      aria-current={run.id === runId ? "page" : undefined}
      className="h-auto min-h-16 w-full items-start justify-start gap-2.5 whitespace-normal px-3 py-2.5 text-left"
      render={<Link to={`/events/${eventId}/runs/${run.id}`} />}
      variant={run.id === runId ? "secondary" : "ghost"}
    >
      <AgentStatusIcon className="mt-0.5" status={run.status} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">
            {run.challengeName}
          </span>
          {run.flag && (
            <Badge size="sm" variant="success">
              <Flag /> Flag found
            </Badge>
          )}
          <Badge
            className="capitalize"
            size="sm"
            variant={statusVariant(run.status)}
          >
            {run.status}
          </Badge>
        </span>
        <span className="mt-1.5 flex min-w-0 items-start gap-2 text-muted-foreground text-xs">
          <span className="min-w-0 flex-1 break-all font-mono">
            {run.provider} / {run.modelId}
          </span>
          <time
            className="shrink-0"
            dateTime={run.updatedAt}
            title={new Date(run.updatedAt).toLocaleString()}
          >
            {runTimeFormatter.format(new Date(run.updatedAt))}
          </time>
        </span>
      </span>
    </Button>
  )
}

function RunSection({
  title,
  eventId,
  runs,
  runId,
}: {
  title: string
  eventId: string
  runs: RunPublic[]
  runId?: string
}) {
  return (
    <section>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <h3 className="font-medium text-muted-foreground text-xs uppercase">
          {title}
        </h3>
        <Badge size="sm" variant="secondary">
          {runs.length}
        </Badge>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-1">
        {runs.map((run) => (
          <RunItem eventId={eventId} key={run.id} run={run} runId={runId} />
        ))}
      </div>
    </section>
  )
}

export function RunsView({
  eventId,
  challenges,
  runId,
}: {
  eventId: string
  challenges: Challenge[]
  runId?: string
}) {
  const [sort, setSort] = useState<"event" | "name" | "recent">("recent")
  const runs = useQuery({
    queryKey: ["runs", "event", eventId],
    queryFn: () =>
      apiRequest<{ items: RunPublic[] }>(`/events/${eventId}/runs`),
  })
  if (runs.isPending)
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" />
        Loading runs...
      </div>
    )
  if (runs.error)
    return (
      <Alert variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load runs</AlertTitle>
        <AlertDescription>{runs.error.message}</AlertDescription>
      </Alert>
    )
  const challengeOrder = new Map(
    challenges.map((challenge, index) => [challenge.id, index])
  )
  const activeRuns = runs.data.items
    .filter((run) => run.status === "running" || run.status === "paused")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const historyRuns = runs.data.items.filter(
    (run) => run.status !== "running" && run.status !== "paused"
  )
  if (sort === "name") {
    historyRuns.sort((left, right) =>
      left.challengeName.localeCompare(right.challengeName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    )
  } else if (sort === "event") {
    historyRuns.sort(
      (left, right) =>
        (challengeOrder.get(left.challengeId) ?? Number.MAX_SAFE_INTEGER) -
          (challengeOrder.get(right.challengeId) ?? Number.MAX_SAFE_INTEGER) ||
        right.updatedAt.localeCompare(left.updatedAt)
    )
  } else if (sort === "recent") {
    historyRuns.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    )
  }
  return (
    <section className="h-full min-h-0 w-full min-w-0">
      <div className="grid h-full min-h-0 w-full min-w-0 grid-cols-[20rem_minmax(0,1fr)] gap-4">
        <CardFrame className="flex h-full min-h-0">
          <CardFrameHeader>
            <CardFrameTitle>
              <span className="flex items-center gap-2">
                <List className="size-4" /> Runs
              </span>
            </CardFrameTitle>
            <CardFrameAction className="gap-1">
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label="Sort run history"
                      size="icon-sm"
                      title="Sort run history"
                      variant="ghost"
                    />
                  }
                >
                  <ArrowUpDown />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuRadioGroup
                    onValueChange={(value) =>
                      setSort(value as "event" | "name" | "recent")
                    }
                    value={sort}
                  >
                    <MenuRadioItem value="recent">
                      Recent activity
                    </MenuRadioItem>
                    <MenuRadioItem value="event">Event order</MenuRadioItem>
                    <MenuRadioItem value="name">Challenge name</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              <CreateRunDialog
                challenges={challenges}
                trigger={<Plus />}
                triggerLabel="Start run"
                triggerSize="icon-sm"
                triggerVariant="ghost"
              />
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="min-h-0 flex-1">
            <CardPanel className="min-h-0 flex-1 overflow-hidden p-0">
              <ScrollArea className="h-full" scrollFade scrollbarGutter>
                <div className="p-3">
                  {runs.data.items.length === 0 ? (
                    <p className="px-3 py-10 text-center text-muted-foreground text-sm">
                      No runs yet
                    </p>
                  ) : (
                    <nav
                      aria-label="Event runs"
                      className="flex flex-col gap-3"
                    >
                      {activeRuns.length > 0 && (
                        <RunSection
                          eventId={eventId}
                          runId={runId}
                          runs={activeRuns}
                          title="Active"
                        />
                      )}
                      {historyRuns.length > 0 && (
                        <RunSection
                          eventId={eventId}
                          runId={runId}
                          runs={historyRuns}
                          title="History"
                        />
                      )}
                    </nav>
                  )}
                </div>
              </ScrollArea>
            </CardPanel>
          </Card>
        </CardFrame>
        <RunWorkspace challenges={challenges} eventId={eventId} runId={runId} />
      </div>
    </section>
  )
}
