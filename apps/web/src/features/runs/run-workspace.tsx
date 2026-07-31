import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  Files,
  History,
  Info,
  Play,
  Square,
  TerminalSquare,
} from "lucide-react"
import { useSearchParams } from "react-router"
import { type Challenge, keys, runsApi } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { toast } from "@/lib/toast"
import { CreateRunDialog } from "./create-run-dialog"
import { FilesWorkspace } from "./files-workspace"
import { RunOverview, statusVariant } from "./run-overview"
import { SessionPanel } from "./session-panel"
import { RunTerminal } from "./terminal"

export function RunWorkspace({
  eventId,
  runId,
  challenges,
}: {
  eventId: string
  runId?: string
  challenges: Challenge[]
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: keys.runs.detail(runId ?? ""),
    refetchOnWindowFocus: false,
    queryFn: () => runsApi.getRun(runId ?? ""),
  })

  const stop = useMutation({
    mutationFn: () => runsApi.stopRun(runId ?? ""),
    onSuccess: () => {
      toast.success("Run stopping")
      void invalidate(queryClient, eventId, runId ?? "")
    },
    onError: (error) => toast.error("Failed to stop run", error.message),
  })

  const resume = useMutation({
    mutationFn: () => runsApi.resumeRun(runId ?? ""),
    onSuccess: () => {
      toast.success("Run resumed")
      void invalidate(queryClient, eventId, runId ?? "")
    },
    onError: (error) => toast.error("Failed to resume run", error.message),
  })

  if (!runId) {
    return (
      <div className="flex min-h-96 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Select a run</EmptyTitle>
            <EmptyDescription>
              {challenges.length > 0
                ? "Open an existing run or start a new run."
                : "Add a challenge before starting a run."}
            </EmptyDescription>
          </EmptyHeader>
          {challenges.length > 0 ? (
            <CreateRunDialog challenges={challenges} />
          ) : null}
        </Empty>
      </div>
    )
  }
  if (detail.isPending) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" />
        Loading run...
      </div>
    )
  }
  if (detail.error) {
    return (
      <Alert className="m-4 w-auto" variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load run</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (!detail.data) return null

  const { run } = detail.data
  const running = run.status === "running"
  const canResume = !running && run.status !== "failed"

  const requestedView = searchParams.get("view")
  const view =
    requestedView === "overview" ||
    requestedView === "files" ||
    requestedView === "session"
      ? requestedView
      : "terminal"

  return (
    <CardFrame className="h-full min-h-0 min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{run.challengeName}</span>
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </span>
        </CardFrameTitle>
        <CardFrameDescription className="truncate font-mono text-xs">
          {run.provider} / {run.modelId}
        </CardFrameDescription>
        <CardFrameAction className="gap-2">
          {canResume && (
            <Button
              loading={resume.isPending}
              onClick={() => resume.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Play /> Resume
            </Button>
          )}
          {running && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    size="sm"
                    type="button"
                    variant="destructive-outline"
                  />
                }
              >
                <Square /> Stop
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                  <AlertDialogDescription>
                    pi receives SIGTERM, saves its session, and the container
                    stops. You can resume the run later from the same session.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    loading={stop.isPending}
                    onClick={() => stop.mutate()}
                    type="button"
                    variant="destructive"
                  >
                    Stop run
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          )}
          <CreateRunDialog
            challenge={{ id: run.challengeId, name: run.challengeName }}
          />
        </CardFrameAction>
      </CardFrameHeader>
      <Card className="min-h-0 flex-1">
        <CardPanel className="h-full min-h-0 p-0">
          <Tabs
            className="flex h-full min-h-0 min-w-0 flex-col"
            onValueChange={(value) => {
              const next = new URLSearchParams(searchParams)
              next.set("view", value)
              setSearchParams(next, { replace: true })
            }}
            value={view}
          >
            <TabsList
              className="mx-6 w-auto shrink-0 justify-start border-b"
              variant="underline"
            >
              <TabsTab className="gap-2" value="terminal">
                <TerminalSquare /> Terminal
              </TabsTab>
              <TabsTab className="gap-2" value="overview">
                <Info /> Overview
              </TabsTab>
              <TabsTab className="gap-2" value="files">
                <Files /> Files
              </TabsTab>
              <TabsTab className="gap-2" value="session">
                <History /> Session
              </TabsTab>
            </TabsList>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="terminal"
            >
              {running ? (
                <RunTerminal active={view === "terminal"} runId={runId} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
                  {canResume
                    ? "Run is stopped. Resume to reconnect the terminal."
                    : "Run is not running."}
                </div>
              )}
            </TabsPanel>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="overview"
            >
              <ScrollArea className="h-full" scrollFade>
                <RunOverview run={run} />
              </ScrollArea>
            </TabsPanel>
            <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="files">
              <FilesWorkspace
                enabled={view === "files"}
                key={runId}
                runId={runId}
              />
            </TabsPanel>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="session"
            >
              <SessionPanel
                enabled={view === "session"}
                runId={runId}
                running={running}
              />
            </TabsPanel>
          </Tabs>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

async function invalidate(
  queryClient: ReturnType<typeof useQueryClient>,
  eventId: string,
  runId: string
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) }),
    queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.all }),
  ])
}
