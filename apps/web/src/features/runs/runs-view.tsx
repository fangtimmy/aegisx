import { useQuery } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  FolderTree,
  ListTree,
  Plus,
} from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { Challenge, RunPublic } from "@/lib/api"
import { apiRequest } from "@/lib/api"
import { CreateRunDialog } from "./create-run-dialog"
import { RunWorkspace } from "./run-workspace"

function RunBranch({
  challenge,
  eventId,
  runs,
  runId,
  onSelect,
}: {
  challenge: Challenge
  eventId: string
  runs: RunPublic[]
  runId?: string
  onSelect?: () => void
}) {
  const challengeRuns = runs.filter((run) => run.challengeId === challenge.id)
  const hasSelectedRun = challengeRuns.some((run) => run.id === runId)
  const [open, setOpen] = useState(hasSelectedRun)

  return (
    <Collapsible onOpenChange={setOpen} open={open || hasSelectedRun}>
      <div className="group flex items-center gap-1">
        <CollapsibleTrigger
          render={
            <Button
              className="h-9 min-w-0 flex-1 justify-start gap-2 px-2 text-left text-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          {open || hasSelectedRun ? <ChevronDown /> : <ChevronRight />}
          <FolderTree className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {challenge.name}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {challengeRuns.length}
          </span>
        </CollapsibleTrigger>
        <CreateRunDialog
          challenge={challenge}
          onCreated={onSelect}
          trigger={<Plus />}
        />
      </div>
      <CollapsiblePanel className="mt-1 ml-4 space-y-1 border-l pb-1 pl-3">
        {challengeRuns.length === 0 ? (
          <p className="px-2 py-2 text-muted-foreground text-xs">No runs</p>
        ) : (
          challengeRuns.map((run) => (
            <Button
              aria-current={run.id === runId ? "page" : undefined}
              className="h-auto min-h-11 w-full justify-start gap-2.5 px-2.5 py-2 text-left"
              key={run.id}
              onClick={onSelect}
              render={<Link to={`/events/${eventId}/runs/${run.id}`} />}
              variant={run.id === runId ? "secondary" : "ghost"}
            >
              <CircleDot
                className={
                  run.status === "running"
                    ? "text-success"
                    : run.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px] leading-5">
                  {run.modelId}
                </span>
                <span className="block capitalize text-muted-foreground text-xs leading-4">
                  {run.status} · {run.environment}
                </span>
              </span>
            </Button>
          ))
        )}
      </CollapsiblePanel>
    </Collapsible>
  )
}

function RunTree({
  eventId,
  challenges,
  runs,
  runId,
  onSelect,
}: {
  eventId: string
  challenges: Challenge[]
  runs: RunPublic[]
  runId?: string
  onSelect?: () => void
}) {
  return (
    <nav aria-label="Event runs" className="flex flex-col gap-1.5">
      {challenges.map((challenge) => (
        <RunBranch
          challenge={challenge}
          eventId={eventId}
          key={challenge.id}
          onSelect={onSelect}
          runId={runId}
          runs={runs}
        />
      ))}
    </nav>
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
  return (
    <section className="h-full min-h-0 w-full min-w-0">
      <div className="grid h-full min-h-0 w-full min-w-0 grid-cols-[20rem_minmax(0,1fr)] gap-4">
        <CardFrame className="flex h-full min-h-0">
          <CardFrameHeader>
            <CardFrameTitle>
              <span className="flex items-center gap-2">
                <ListTree className="size-4" /> Runs
              </span>
            </CardFrameTitle>
          </CardFrameHeader>
          <Card className="min-h-0 flex-1">
            <CardPanel className="min-h-0 flex-1 overflow-y-auto p-3">
              <RunTree
                challenges={challenges}
                eventId={eventId}
                runId={runId}
                runs={runs.data.items}
              />
            </CardPanel>
          </Card>
        </CardFrame>
        <RunWorkspace challenges={challenges} eventId={eventId} runId={runId} />
      </div>
    </section>
  )
}
