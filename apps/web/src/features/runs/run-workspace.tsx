import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Pause, Play, Send, Square } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router"
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type {
  Challenge,
  RunPublic,
  RunStatus,
  SessionEntry,
  UsageSummary,
} from "@/lib/api"
import { apiRequest, jsonRequest } from "@/lib/api"
import { CreateRunDialog } from "./create-run-dialog"
import { FilesWorkspace } from "./files-workspace"
import { RunOverview, statusVariant } from "./run-overview"
import {
  Conversation,
  isRecord,
  liveItems,
  type TimelineItem,
  text,
} from "./timeline"

const statuses: RunStatus[] = [
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
]

export function RunWorkspace({
  eventId,
  runId,
  challenges,
}: {
  eventId: string
  runId?: string
  challenges: Challenge[]
}) {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [draft, setDraft] = useState("")
  const [live, setLive] = useState<TimelineItem[]>([])
  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: ["runs", runId ?? ""],
    queryFn: () =>
      apiRequest<{
        run: RunPublic
        history: SessionEntry[]
        stats: UsageSummary
      }>(`/runs/${runId}`),
  })
  const control = useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: "message" | "pause" | "resume" | "stop"
      body: object
    }) =>
      apiRequest<void>(`/runs/${runId}/${action}`, jsonRequest("POST", body)),
    onSuccess: async (_, variables) => {
      if (variables.action === "message" || variables.action === "resume") {
        setDraft("")
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["runs", runId ?? ""],
        }),
        queryClient.invalidateQueries({
          queryKey: ["runs", "event", eventId],
        }),
      ])
    },
  })

  useEffect(() => {
    setLive([])
    if (!runId) return
    const source = new EventSource(`/api/runs/${runId}/events`)
    source.onmessage = (event) => {
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        payload = { type: "error", error: event.data }
      }
      if (!isRecord(payload)) return
      const items = liveItems(payload)
      if (items.length > 0) {
        const keys = new Set(items.map((item) => item.key))
        setLive((current) => [
          ...current.filter((value) => !keys.has(value.key)),
          ...items,
        ])
      }
      const status = text(
        payload.status ??
          (isRecord(payload.run) ? payload.run.status : undefined)
      )
      if (statuses.includes(status as RunStatus)) {
        queryClient.setQueryData<{
          run: RunPublic
          history: SessionEntry[]
          stats: UsageSummary
        }>(["runs", runId], (current) =>
          current
            ? {
                ...current,
                run: { ...current.run, status: status as RunStatus },
              }
            : current
        )
      }
      if (
        payload.type === "entry_appended" ||
        payload.type === "message_end" ||
        statuses.includes(status as RunStatus)
      ) {
        queryClient.invalidateQueries({ queryKey: ["runs", runId] })
        queryClient.invalidateQueries({
          queryKey: ["runs", "event", eventId],
        })
      }
    }
    return () => source.close()
  }, [eventId, queryClient, runId])

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
          ) : (
            <Button render={<Link to={`/events/${eventId}`} />}>
              Add challenge
            </Button>
          )}
        </Empty>
      </div>
    )
  }
  if (detail.isPending)
    return (
      <div
        className="flex items-center gap-2 p-6 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" />
        Loading run...
      </div>
    )
  if (detail.error)
    return (
      <Alert className="m-4 w-auto" variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load run</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    )
  if (!detail.data) return null
  const { run, history, stats } = detail.data
  const active = run.status === "running" || run.status === "paused"
  const canMessage = run.status === "running"
  const requestedView = searchParams.get("view")
  const view =
    requestedView === "overview" ||
    requestedView === "conversation" ||
    requestedView === "files"
      ? requestedView
      : "conversation"

  function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (message) control.mutate({ action: "message", body: { message } })
  }

  return (
    <div className="flex min-h-[36rem] min-w-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold text-base">
              {run.challengeName}
            </h2>
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </div>
          <p className="mt-1 truncate font-mono text-muted-foreground text-xs">
            {run.provider} / {run.modelId}
          </p>
        </div>
        <CreateRunDialog
          challenge={{ id: run.challengeId, name: run.challengeName }}
        />
      </header>
      <Tabs
        className="min-h-0 flex-1 px-4 pt-2"
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("view", value)
          setSearchParams(next, { replace: true })
        }}
        value={view}
      >
        <TabsList className="w-full justify-start border-b" variant="underline">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="conversation">Conversation</TabsTab>
          <TabsTab value="files">Files</TabsTab>
        </TabsList>
        <TabsPanel value="overview">
          <RunOverview run={run} stats={stats} />
        </TabsPanel>
        <TabsPanel className="min-h-0" value="conversation">
          <ScrollArea className="h-[min(52vh,34rem)]">
            <Conversation history={history} live={live} />
          </ScrollArea>
        </TabsPanel>
        <TabsPanel value="files">
          <FilesWorkspace
            enabled={view === "files"}
            key={runId}
            runId={runId}
          />
        </TabsPanel>
      </Tabs>
      <div className="border-t bg-muted/20 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {run.status === "running" && (
            <Button
              loading={
                control.isPending && control.variables?.action === "pause"
              }
              onClick={() => control.mutate({ action: "pause", body: {} })}
              size="sm"
              variant="outline"
            >
              <Pause /> Pause
            </Button>
          )}
          {run.status === "paused" && (
            <Button
              loading={
                control.isPending && control.variables?.action === "resume"
              }
              onClick={() =>
                control.mutate({
                  action: "resume",
                  body: { message: draft.trim() || undefined },
                })
              }
              size="sm"
              variant="outline"
            >
              <Play /> Resume
            </Button>
          )}
          {active && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button size="sm" variant="destructive-outline" />}
              >
                <Square /> Stop
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The active agent process will be terminated and cannot be
                    resumed.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    loading={
                      control.isPending && control.variables?.action === "stop"
                    }
                    onClick={() => control.mutate({ action: "stop", body: {} })}
                    type="button"
                    variant="destructive"
                  >
                    Stop run
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          )}
          <span className="ml-auto text-muted-foreground text-xs" role="status">
            Run is {run.status}
            {control.isPending ? ` · ${control.variables?.action} pending` : ""}
          </span>
        </div>
        <form className="flex items-end gap-2" onSubmit={send}>
          <Field className="min-w-0 flex-1">
            <FieldLabel className="sr-only" htmlFor="run-message">
              Message to agent
            </FieldLabel>
            <Textarea
              className="min-h-0"
              disabled={!active || control.isPending}
              id="run-message"
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                run.status === "paused"
                  ? "Optional guidance when resuming"
                  : active
                    ? "Send guidance to the agent"
                    : `Messaging unavailable while ${run.status}`
              }
              rows={2}
              size="sm"
              value={draft}
            />
          </Field>
          <Button
            aria-label="Send message"
            disabled={!canMessage || !draft.trim()}
            loading={
              control.isPending && control.variables?.action === "message"
            }
            size="icon"
            type="submit"
          >
            <Send />
          </Button>
        </form>
        {control.error && (
          <Alert className="mt-2" variant="error">
            <CircleAlert />
            <AlertDescription>{control.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  )
}
