import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpDown,
  CircleAlert,
  Flag,
  List,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router"
import { type Challenge, keys, type RunPublic, runsApi } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/lib/toast"
import { CreateRunDialog } from "./create-run-dialog"
import { RunWorkspace } from "./run-workspace"

function RunStatusBadge({ status }: { status: RunPublic["status"] }) {
  if (status === "running")
    return (
      <Badge size="sm" variant="info" className="gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-info" />
        running
      </Badge>
    )
  if (status === "idle")
    return (
      <Badge size="sm" variant="success">
        idle
      </Badge>
    )
  return (
    <Badge size="sm" variant="secondary">
      shelved
    </Badge>
  )
}

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
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteMutation = useMutation({
    mutationFn: () => runsApi.deleteRun(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) })
      toast.success("Run deleted")
      if (run.id === runId) {
        navigate(`/events/${eventId}/runs`)
      }
    },
    onError: (error) => toast.error("Failed to delete run", error.message),
  })
  return (
    <div className="group relative">
      <Button
        aria-current={run.id === runId ? "page" : undefined}
        className="h-auto min-h-16 w-full items-start justify-start gap-2.5 whitespace-normal px-3 py-2.5 pr-10 text-left"
        render={<Link to={`/events/${eventId}/runs/${run.id}`} />}
        variant={run.id === runId ? "secondary" : "ghost"}
      >
        <span className="mt-0.5 shrink-0">
          <RunStatusBadge status={run.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {run.challengeName}
            </span>
            {run.hasFlag && (
              <Badge size="sm" variant="success">
                <Flag />
              </Badge>
            )}
          </span>
          <span className="mt-1.5 flex min-w-0 items-start gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 break-all font-mono">
              {run.provider} / {run.modelName}
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
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="Run actions"
                size="icon-sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmDelete(true)}
              variant="destructive"
            >
              <Trash2 />
              Delete run
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => setConfirmDelete(open)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete run for {run.challengeName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the run, its conversation history, and
              workspace files.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </AlertDialogClose>
            <Button
              loading={deleteMutation.isPending}
              onClick={() => {
                deleteMutation.mutate()
                setConfirmDelete(false)
              }}
              type="button"
              variant="destructive"
            >
              Delete run
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
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
    queryKey: keys.runs.byEvent(eventId),
    queryFn: () => runsApi.listEventRuns(eventId),
    // Central status sync: poll the list while any run is active so every
    // consumer (list + derived detail) stays current with no WS coupling.
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => run.status === "running")
        ? 5000
        : false,
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
    .filter((run) => run.status !== "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const historyRuns = runs.data.items.filter((run) => run.status === "closed")
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
                          title="Shelved"
                        />
                      )}
                    </nav>
                  )}
                </div>
              </ScrollArea>
            </CardPanel>
          </Card>
        </CardFrame>
        <RunWorkspace
          challenges={challenges}
          eventId={eventId}
          key={runId ?? "no-run"}
          runId={runId}
        />
      </div>
    </section>
  )
}
