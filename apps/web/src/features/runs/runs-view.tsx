import { useQuery } from "@tanstack/react-query"
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
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
  CardFrameAction,
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
      <div className="group relative flex items-center rounded-md hover:bg-accent/50 focus-within:bg-accent/50">
        <CollapsibleTrigger
          render={
            <Button
              className="h-9 min-w-0 flex-1 justify-start gap-2 bg-transparent px-2 pr-10 text-left text-sm hover:bg-transparent data-pressed:bg-transparent"
              type="button"
              variant="ghost"
            />
          }
        >
          {open || hasSelectedRun ? <ChevronDown /> : <ChevronRight />}
          <span className="min-w-0 flex-1 truncate font-medium">
            {challenge.name}
          </span>
          <span className="tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            {challengeRuns.length}
          </span>
        </CollapsibleTrigger>
        <div className="pointer-events-none absolute right-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [&_[data-slot=button]]:hover:bg-accent">
          <CreateRunDialog
            challenge={challenge}
            onCreated={onSelect}
            trigger={<Plus />}
            triggerVariant="ghost"
          />
        </div>
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
  const [sort, setSort] = useState<"event" | "name" | "recent">("event")
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
  const latestActivity = new Map<string, string>()
  for (const run of runs.data.items) {
    const current = latestActivity.get(run.challengeId)
    if (!current || run.updatedAt > current) {
      latestActivity.set(run.challengeId, run.updatedAt)
    }
  }
  const sortedChallenges = [...challenges]
  if (sort === "name") {
    sortedChallenges.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    )
  } else if (sort === "recent") {
    sortedChallenges.sort((left, right) =>
      (latestActivity.get(right.id) ?? "").localeCompare(
        latestActivity.get(left.id) ?? ""
      )
    )
  }
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
            <CardFrameAction className="gap-1">
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label="Sort challenges"
                      size="icon-sm"
                      title="Sort challenges"
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
                    <MenuRadioItem value="event">Event order</MenuRadioItem>
                    <MenuRadioItem value="name">Name</MenuRadioItem>
                    <MenuRadioItem value="recent">
                      Recent activity
                    </MenuRadioItem>
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
                  <RunTree
                    challenges={sortedChallenges}
                    eventId={eventId}
                    runId={runId}
                    runs={runs.data.items}
                  />
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
