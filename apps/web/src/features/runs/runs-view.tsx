import { useQuery } from "@tanstack/react-query"
import { CircleAlert, ListTree, Plus } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Frame, FramePanel } from "@/components/ui/frame"
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
    <nav aria-label="Event runs" className="flex flex-col gap-4">
      {challenges.map((challenge) => {
        const challengeRuns = runs.filter(
          (run) => run.challengeId === challenge.id
        )
        return (
          <section key={challenge.id}>
            <div className="flex items-center justify-between gap-2 px-2">
              <h3 className="truncate font-medium text-xs">{challenge.name}</h3>
              <CreateRunDialog
                challenge={challenge}
                onCreated={onSelect}
                trigger={
                  <Plus aria-label={`Start run for ${challenge.name}`} />
                }
              />
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              {challengeRuns.length === 0 && (
                <p className="px-2 py-1 text-muted-foreground text-xs">
                  No runs
                </p>
              )}
              {challengeRuns.map((run) => (
                <Button
                  aria-current={run.id === runId ? "page" : undefined}
                  className="h-auto w-full justify-start px-2 py-1.5 text-left"
                  key={run.id}
                  onClick={onSelect}
                  render={<Link to={`/events/${eventId}/runs/${run.id}`} />}
                  variant={run.id === runId ? "secondary" : "ghost"}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">
                      {run.modelId}
                    </span>
                    <span className="block capitalize text-[11px] text-muted-foreground">
                      {run.status} · {run.environment}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </section>
        )
      })}
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
    <Frame className="mt-4">
      <FramePanel className="overflow-hidden p-0 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden border-r bg-muted/20 p-3 lg:block">
          <div className="mb-4 flex items-center gap-2 px-2">
            <ListTree className="size-4" />
            <h2 className="font-medium text-sm">Runs</h2>
          </div>
          <RunTree
            challenges={challenges}
            eventId={eventId}
            runId={runId}
            runs={runs.data.items}
          />
        </aside>
        <div className="border-b p-3 lg:hidden">
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
        <RunWorkspace challenges={challenges} eventId={eventId} runId={runId} />
      </FramePanel>
    </Frame>
  )
}
