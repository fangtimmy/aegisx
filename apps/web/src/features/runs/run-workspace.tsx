import {
  Bot,
  BotMessageSquare,
  CircleAlert,
  Files,
  GitFork,
  Info,
  Pause,
  Play,
  Send,
  Square,
} from "lucide-react"
import { useState } from "react"
import { Link, useSearchParams } from "react-router"
import type { Challenge } from "@/api"
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
import { AgentActivityBadge } from "./agent-activity-badge"
import { AgentInspectorButton } from "./agent-inspector"
import { AgentStatusIcon } from "./agent-status-icon"
import { CreateRunDialog } from "./create-run-dialog"
import { FilesWorkspace } from "./files-workspace"
import { RunOverview, statusVariant } from "./run-overview"
import { Conversation } from "./timeline"
import { useRunController } from "./use-run-controller"

const defaultResumeMessage =
  "Continue solving the challenge from the current state."

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
  const [draft, setDraft] = useState("")
  const requestedAgentId = searchParams.get("agent")
  const controller = useRunController({
    eventId,
    onMessageSent: () => setDraft(""),
    requestedAgentId,
    runId,
  })
  const {
    agentDetail,
    control,
    detail,
    retryMessage,
    selectedAgent,
    streamDisconnected,
    streamStore,
  } = controller

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
  const requestedView = searchParams.get("view")
  const view =
    requestedView === "overview" ||
    requestedView === "conversation" ||
    requestedView === "files"
      ? requestedView
      : "conversation"
  const showComposer = view === "conversation" && active && mainSelected
  const canSubmit =
    showComposer &&
    !control.isPending &&
    (run.status === "paused" || Boolean(draft.trim()))

  function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    const outgoingMessage = message || defaultResumeMessage
    const clientMessageId =
      retryMessage.current?.text === outgoingMessage
        ? retryMessage.current.id
        : crypto.randomUUID()
    retryMessage.current = { id: clientMessageId, text: outgoingMessage }
    if (selectedAgent && (message || run.status === "paused")) {
      const createdAt = new Date().toISOString()
      streamStore.addPendingMessage({
        id: clientMessageId,
        agentId: selectedAgent.id,
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt,
        message: {
          role: "user",
          timestamp: Date.parse(createdAt),
          content: [
            {
              type: "text",
              text: outgoingMessage,
            },
          ],
        },
      })
    }
    if (run.status === "paused") {
      control.mutate({
        action: "resume",
        body: { message: message || undefined, clientMessageId },
        agentId: selectedAgent?.id,
      })
    } else if (message) {
      control.mutate({
        action: "message",
        body: { message, clientMessageId },
        agentId: selectedAgent?.id,
      })
    }
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
                  <RunOverview agents={agents} run={run} stats={stats} />
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
                    <div className="mx-6 flex min-w-0 shrink-0 items-center gap-2 border-b">
                      <TabsList
                        className="min-w-0 max-w-[calc(100%-2.5rem)] justify-start overflow-x-auto"
                        variant="underline"
                      >
                        {agents.map((agent) => (
                          <TabsTab
                            className="px-2"
                            key={agent.id}
                            value={agent.id}
                          >
                            {agent.parentAgentId === null ? (
                              <Bot aria-hidden="true" />
                            ) : (
                              <GitFork aria-hidden="true" />
                            )}
                            <span className="max-w-40 truncate">
                              {agent.name}
                            </span>
                            <AgentStatusIcon status={agent.status} />
                          </TabsTab>
                        ))}
                      </TabsList>
                      <div className="ml-auto shrink-0">
                        <AgentInspectorButton
                          agent={selectedAgent}
                          runId={runId}
                        />
                      </div>
                    </div>
                    <TabsPanel
                      className="min-h-0 overflow-hidden"
                      value={selectedAgent.id}
                    >
                      {!mainSelected && agentDetail.isPending ? (
                        <div
                          className="flex items-center gap-2 p-6 text-muted-foreground text-sm"
                          role="status"
                        >
                          <Spinner aria-hidden="true" />
                          Loading conversation...
                        </div>
                      ) : !mainSelected && agentDetail.error ? (
                        <Alert className="m-4 w-auto" variant="error">
                          <CircleAlert />
                          <AlertDescription>
                            {agentDetail.error.message}
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <ScrollArea className="relative h-full pr-1" scrollFade>
                          <Conversation
                            agentId={selectedAgent.id}
                            key={selectedAgent.id}
                            stream={streamStore}
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
            {streamDisconnected && (
              <Alert className="mx-6 mb-3 w-auto" variant="warning">
                <CircleAlert />
                <AlertDescription>
                  Live updates are disconnected. Reconnecting...
                </AlertDescription>
              </Alert>
            )}
            {(showComposer || active || control.error) && (
              <div className="border-t bg-background/95 px-6 py-3">
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
                        disabled={control.isPending}
                        id="run-message"
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={
                          run.status === "paused"
                            ? "Optional guidance when resuming"
                            : "Send guidance to the agent"
                        }
                        rows={20}
                        size="sm"
                        value={draft}
                      />
                    </Field>
                    <Button
                      aria-label={
                        run.status === "paused" ? "Resume run" : "Send message"
                      }
                      disabled={!canSubmit}
                      loading={
                        control.isPending &&
                        (control.variables?.action === "message" ||
                          control.variables?.action === "resume")
                      }
                      size="icon"
                      title={
                        run.status === "paused" ? "Resume run" : "Send message"
                      }
                      type="submit"
                    >
                      {run.status === "paused" ? <Play /> : <Send />}
                    </Button>
                  </form>
                )}
                <div
                  className={`mx-auto flex max-w-3xl flex-wrap items-center gap-2 ${showComposer ? "mt-3" : ""}`}
                >
                  {(active || control.isPending) && (
                    <span
                      className="text-muted-foreground text-xs"
                      role="status"
                    >
                      Run is {run.status}
                      {control.isPending
                        ? ` · ${control.variables?.action} pending`
                        : ""}
                    </span>
                  )}
                  {active && selectedAgent && (
                    <AgentActivityBadge
                      agentId={selectedAgent.id}
                      agentStatus={selectedAgent.status}
                      stream={streamStore}
                    />
                  )}
                  {run.status === "running" && (
                    <Button
                      className="ml-auto"
                      loading={
                        control.isPending &&
                        control.variables?.action === "pause"
                      }
                      onClick={() =>
                        control.mutate({ action: "pause", body: {} })
                      }
                      variant="outline"
                    >
                      <Pause /> Pause
                    </Button>
                  )}
                  {active && (
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            className={run.status === "paused" ? "ml-auto" : ""}
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
                </div>
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
