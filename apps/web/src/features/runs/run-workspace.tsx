import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  BotMessageSquare,
  CircleAlert,
  Files,
  Info,
  Pause,
  Play,
  Send,
  Square,
} from "lucide-react"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type {
  AgentPublic,
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
  type LiveEntry,
  liveEntries,
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
  const [liveByAgent, setLiveByAgent] = useState<Record<string, LiveEntry[]>>(
    {}
  )
  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: ["runs", runId ?? ""],
    queryFn: () =>
      apiRequest<{
        run: RunPublic
        agents: AgentPublic[]
        stats: UsageSummary
      }>(`/runs/${runId}`),
  })
  const requestedAgentId = searchParams.get("agent")
  const selectedAgent =
    detail.data?.agents.find((agent) => agent.id === requestedAgentId) ??
    detail.data?.agents.find((agent) => agent.parentAgentId === null) ??
    detail.data?.agents[0]
  const agentDetail = useQuery({
    enabled: Boolean(runId && selectedAgent),
    queryKey: ["runs", runId ?? "", "agents", selectedAgent?.id ?? ""],
    queryFn: () =>
      apiRequest<{
        agent: AgentPublic
        history: SessionEntry[]
        stats: UsageSummary
      }>(`/runs/${runId}/agents/${selectedAgent?.id}`),
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
        queryClient.invalidateQueries({
          queryKey: ["runs", runId ?? "", "agents", selectedAgent?.id ?? ""],
        }),
      ])
    },
  })

  useEffect(() => {
    setLiveByAgent({})
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
      const agentEvent = isRecord(payload.event) ? payload.event : null
      const agentId = text(payload.agentId)
      const entries = agentEvent ? liveEntries(agentEvent) : []
      if (agentId && entries.length > 0) {
        setLiveByAgent((current) => {
          const next = [...(current[agentId] ?? [])]
          for (const entry of entries) {
            const index = next.findIndex((value) => value.key === entry.key)
            if (index === -1) next.push(entry)
            else next[index] = entry
          }
          return { ...current, [agentId]: next }
        })
      }
      const status = text(
        payload.status ??
          (isRecord(payload.run) ? payload.run.status : undefined)
      )
      if (statuses.includes(status as RunStatus)) {
        queryClient.setQueryData<{
          run: RunPublic
          agents: AgentPublic[]
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
        payload.type === "agent_status" ||
        agentEvent?.type === "entry_appended" ||
        agentEvent?.type === "message_end" ||
        statuses.includes(status as RunStatus)
      ) {
        queryClient.invalidateQueries({ queryKey: ["runs", runId] })
        if (agentId) {
          queryClient.invalidateQueries({
            queryKey: ["runs", runId, "agents", agentId],
          })
        }
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
  const { run, agents, stats } = detail.data
  const active = run.status === "running" || run.status === "paused"
  const mainSelected = selectedAgent?.parentAgentId === null
  const canMessage = run.status === "running" && mainSelected
  const requestedView = searchParams.get("view")
  const view =
    requestedView === "overview" ||
    requestedView === "conversation" ||
    requestedView === "files"
      ? requestedView
      : "conversation"
  const showComposer = view === "conversation" && active && mainSelected

  function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (message) control.mutate({ action: "message", body: { message } })
  }

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
        <CardFrameAction>
          <CreateRunDialog
            challenge={{ id: run.challengeId, name: run.challengeName }}
          />
        </CardFrameAction>
      </CardFrameHeader>
      <Card className="min-h-0 flex-1">
        <CardPanel className="h-full min-h-0 p-0">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <Tabs
              className="flex min-h-0 flex-1 flex-col"
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
                <TabsTab className="gap-2" value="overview">
                  <Info /> Overview
                </TabsTab>
                <TabsTab className="gap-2" value="conversation">
                  <BotMessageSquare /> Conversation
                </TabsTab>
                <TabsTab className="gap-2" value="files">
                  <Files /> Files
                </TabsTab>
              </TabsList>
              <TabsPanel className="min-h-0 overflow-hidden" value="overview">
                <ScrollArea className="h-full" scrollFade>
                  <RunOverview run={run} stats={stats} />
                </ScrollArea>
              </TabsPanel>
              <TabsPanel
                className="min-h-0 overflow-hidden"
                value="conversation"
              >
                {selectedAgent && (
                  <Tabs
                    className="h-full min-h-0 gap-0"
                    onValueChange={(value) => {
                      const next = new URLSearchParams(searchParams)
                      next.set("agent", value)
                      setSearchParams(next, { replace: true })
                    }}
                    value={selectedAgent.id}
                  >
                    <TabsList
                      className="mx-6 max-w-[calc(100%-3rem)] shrink-0 justify-start overflow-x-auto border-b"
                      variant="underline"
                    >
                      {agents.map((agent) => (
                        <TabsTab key={agent.id} value={agent.id}>
                          <span className="max-w-40 truncate">
                            {agent.name}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {agent.status}
                          </span>
                        </TabsTab>
                      ))}
                    </TabsList>
                    <TabsPanel
                      className="min-h-0 overflow-hidden"
                      value={selectedAgent.id}
                    >
                      {agentDetail.isPending ? (
                        <div
                          className="flex items-center gap-2 p-6 text-muted-foreground text-sm"
                          role="status"
                        >
                          <Spinner aria-hidden="true" />
                          Loading conversation...
                        </div>
                      ) : agentDetail.error ? (
                        <Alert className="m-4 w-auto" variant="error">
                          <CircleAlert />
                          <AlertDescription>
                            {agentDetail.error.message}
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <ScrollArea className="h-full pr-1" scrollFade>
                          <Conversation
                            history={agentDetail.data?.history ?? []}
                            live={liveByAgent[selectedAgent.id] ?? []}
                          />
                        </ScrollArea>
                      )}
                    </TabsPanel>
                  </Tabs>
                )}
              </TabsPanel>
              <TabsPanel className="min-h-0 overflow-hidden" value="files">
                <FilesWorkspace
                  enabled={view === "files"}
                  key={runId}
                  runId={runId}
                />
              </TabsPanel>
            </Tabs>
            {(showComposer || active || control.error) && (
              <div className="mt-4 border-t px-6 py-4">
                <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2">
                  {run.status === "running" && (
                    <Button
                      loading={
                        control.isPending &&
                        control.variables?.action === "pause"
                      }
                      onClick={() =>
                        control.mutate({ action: "pause", body: {} })
                      }
                      size="sm"
                      variant="outline"
                    >
                      <Pause /> Pause
                    </Button>
                  )}
                  {run.status === "paused" && (
                    <Button
                      loading={
                        control.isPending &&
                        control.variables?.action === "resume"
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
                        render={
                          <Button size="sm" variant="destructive-outline" />
                        }
                      >
                        <Square /> Stop
                      </AlertDialogTrigger>
                      <AlertDialogPopup>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The active agent process will be terminated and
                            cannot be resumed.
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
                              control.isPending &&
                              control.variables?.action === "stop"
                            }
                            onClick={() =>
                              control.mutate({ action: "stop", body: {} })
                            }
                            type="button"
                            variant="destructive"
                          >
                            Stop run
                          </Button>
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
                  )}
                  {(active || control.isPending) && (
                    <span
                      className="ml-auto text-muted-foreground text-xs"
                      role="status"
                    >
                      Run is {run.status}
                      {control.isPending
                        ? ` · ${control.variables?.action} pending`
                        : ""}
                    </span>
                  )}
                </div>
                {showComposer && (
                  <form
                    className="mx-auto flex max-w-3xl items-end gap-2"
                    onSubmit={send}
                  >
                    <Field className="min-w-0 flex-1">
                      <FieldLabel className="sr-only" htmlFor="run-message">
                        Message to agent
                      </FieldLabel>
                      <Textarea
                        className="min-h-0 resize-none bg-muted/30"
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
                        control.isPending &&
                        control.variables?.action === "message"
                      }
                      size="icon"
                      type="submit"
                    >
                      <Send />
                    </Button>
                  </form>
                )}
                {control.error && (
                  <Alert className="mx-auto mt-2 max-w-3xl" variant="error">
                    <CircleAlert />
                    <AlertDescription>{control.error.message}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </div>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}
