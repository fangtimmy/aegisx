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
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
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
              className="h-8 min-w-0 flex-1 justify-start gap-1.5 px-1.5 text-left text-xs"
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
      <CollapsiblePanel className="ml-3 border-l pl-2">
        {challengeRuns.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">No runs</p>
        ) : (
          challengeRuns.map((run) => (
            <Button
              aria-current={run.id === runId ? "page" : undefined}
              className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
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
                <span className="block truncate font-mono text-xs">
                  {run.modelId}
                </span>
                <span className="block capitalize text-[11px] text-muted-foreground">
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
    <nav aria-label="Event runs" className="flex flex-col gap-1">
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
  const [treeOpen, setTreeOpen] = useState(false)
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
    <section className="min-w-0">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <CardFrame className="hidden h-auto max-h-[calc(100svh-8rem)] lg:sticky lg:top-4 lg:flex">
          <CardFrameHeader>
            <CardFrameTitle>
              <span className="flex items-center gap-2">
                <ListTree className="size-4" /> Runs
              </span>
            </CardFrameTitle>
          </CardFrameHeader>
          <Card>
            <CardPanel className="max-h-[calc(100svh-12rem)] overflow-y-auto p-2">
              <RunTree
                challenges={challenges}
                eventId={eventId}
                runId={runId}
                runs={runs.data.items}
              />
            </CardPanel>
          </Card>
        </CardFrame>
        <div className="pb-3 lg:hidden">
          <Sheet onOpenChange={setTreeOpen} open={treeOpen}>
            <SheetTrigger render={<Button type="button" variant="outline" />}>
              <ListTree /> Browse runs
            </SheetTrigger>
            <SheetPopup className="max-w-xs" side="left">
              <SheetHeader>
                <SheetTitle>Runs</SheetTitle>
                <SheetDescription>Runs grouped by challenge</SheetDescription>
              </SheetHeader>
              <SheetPanel>
                <RunTree
                  challenges={challenges}
                  eventId={eventId}
                  onSelect={() => setTreeOpen(false)}
                  runId={runId}
                  runs={runs.data.items}
                />
              </SheetPanel>
            </SheetPopup>
          </Sheet>
        </div>
        <Card className="min-w-0 lg:sticky lg:top-4 lg:h-[calc(100svh-6rem)] lg:min-h-0">
          <CardPanel className="min-h-0 p-0">
            <RunWorkspace
              challenges={challenges}
              eventId={eventId}
              runId={runId}
            />
          </CardPanel>
        </Card>
      </div>
    </section>
  )
}
