import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  CircleAlert,
  Files,
  Info,
  MessageSquare,
  Square,
} from "lucide-react"
import { useCallback } from "react"
import { useSearchParams } from "react-router"

import {
  type Challenge,
  type ThinkingLevel,
  agentsApi,
  keys,
  runsApi,
} from "@/api"
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

import { Conversation } from "./conversation"
import { CreateRunDialog } from "./create-run-dialog"
import { FilesWorkspace } from "./files-workspace"
import { type AvailableModel } from "./model-switcher"
import { RunOverview, runStatusLabel, statusVariant } from "./run-overview"

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

  // The run list is the single source of truth — RunsView polls it while any
  // run is active. The selected run is derived from it so list and detail
  // never drift, and status sync needs no WS coupling.
  const runs = useQuery({
    queryKey: keys.runs.byEvent(eventId),
    queryFn: () => runsApi.listEventRuns(eventId),
  })
  // Agents come from the run detail endpoint (list rows carry no agents).
  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: runId ? keys.runs.detail(runId) : ["runs", "none"],
    queryFn: () => runsApi.getRun(runId ?? ""),
    refetchInterval: (query) =>
      query.state.data && query.state.data.run.status === "running"
        ? 5000
        : false,
  })

  const stop = useMutation({
    mutationFn: () => runsApi.stopRun(runId ?? ""),
    onSuccess: () => {
      toast.success("任务正在停止")
      void invalidate(queryClient, eventId)
    },
    onError: (error) => toast.error("停止任务失败", error.message),
  })

  const close = useMutation({
    mutationFn: () => runsApi.closeRun(runId ?? ""),
    onSuccess: () => {
      toast.success("任务已关闭")
      void invalidate(queryClient, eventId)
    },
    onError: (error) => toast.error("关闭任务失败", error.message),
  })

  if (!runId) {
    return (
      <div className="flex min-h-96 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>选择一个任务</EmptyTitle>
            <EmptyDescription>
              {challenges.length > 0
                ? "打开已有任务或启动一个新任务。"
                : "启动任务前请先添加题目。"}
            </EmptyDescription>
          </EmptyHeader>
          {challenges.length > 0 ? (
            <CreateRunDialog challenges={challenges} />
          ) : null}
        </Empty>
      </div>
    )
  }
  const run = runs.data?.items.find((item) => item.id === runId)
  if (runs.isPending) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载任务…
      </div>
    )
  }
  if (runs.error) {
    return (
      <Alert className="m-4 w-auto" variant="error">
        <CircleAlert />
        <AlertTitle>无法加载任务</AlertTitle>
        <AlertDescription>{runs.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (!run) {
    return (
      <Alert className="m-4 w-auto" variant="error">
        <CircleAlert />
        <AlertTitle>未找到任务</AlertTitle>
        <AlertDescription>
          该任务可能已被删除。请从列表中选择另一个。
        </AlertDescription>
      </Alert>
    )
  }

  const running = run.status === "running"
  const agents = detail.data?.agents ?? []

  // Conversation adapter — stable callbacks so the SSE connection effect
  // does not reconnect on re-render. Send/switch target the *selected* agent
  // (per-agent endpoints, spec §10); model switch refreshes the run list so
  // the header + switcher re-derive the current model.
  const loadMessages = useCallback(
    () => runsApi.listMessages(runId, 0).then((list) => list.items),
    [runId]
  )
  const sendMessage = useCallback(
    (agentId: string, text: string, deliverAs?: "steer" | "followUp") =>
      agentsApi.sendMessage(agentId, { text, deliverAs }),
    []
  )
  const switchModel = useCallback(
    (
      agentId: string,
      input: {
        modelId: string
        thinkingLevel: ThinkingLevel
      }
    ) =>
      agentsApi
        .switchModel(agentId, input)
        .then(() => invalidate(queryClient, eventId)),
    [eventId, queryClient]
  )
  const setQueue = useCallback(
    (_agentId: string, body: { steering: string[]; followUp: string[] }) =>
      runsApi.setQueue(runId, body),
    [runId]
  )
  const findCurrentModelId = useCallback(
    (models: AvailableModel[]) =>
      models.find(
        (m) => m.modelId === run.modelId && m.providerLabel === run.provider
      )?.id,
    [run.modelId, run.provider]
  )

  const requestedView = searchParams.get("view")
  const view =
    requestedView === "overview" ||
    requestedView === "files" ||
    requestedView === "conversation"
      ? requestedView
      : "conversation"

  return (
    <CardFrame className="h-full min-h-0 min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{run.challengeName}</span>
            <Badge variant={statusVariant(run.status)}>
              {runStatusLabel(run.status)}
            </Badge>
          </span>
        </CardFrameTitle>
        <CardFrameDescription className="truncate font-mono text-xs">
          {run.provider} / {run.modelId}
        </CardFrameDescription>
        <CardFrameAction className="gap-2">
          {(running || run.status === "idle") && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button size="sm" type="button" variant="outline" />}
              >
                <Archive /> 关闭
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>关闭该任务？</AlertDialogTitle>
                  <AlertDialogDescription>
                    容器与会话将被释放（warm →
                    closed），对话历史与工作区文件保留；之后发送消息会重建容器后继续。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    取消
                  </AlertDialogClose>
                  <Button
                    loading={close.isPending}
                    onClick={() => close.mutate()}
                    type="button"
                  >
                    关闭任务
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          )}
          {running && (
            <Button
              loading={stop.isPending}
              onClick={() => stop.mutate()}
              size="sm"
              title="取消当前轮次（容器保留），发送消息即可继续"
              type="button"
              variant="destructive-outline"
            >
              <Square /> 停止
            </Button>
          )}
          <CreateRunDialog
            challenge={{ id: run.challengeId ?? "", name: run.challengeName }}
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
              <TabsTab className="gap-2" value="conversation">
                <MessageSquare /> 对话
              </TabsTab>
              <TabsTab className="gap-2" value="overview">
                <Info /> 概览
              </TabsTab>
              <TabsTab className="gap-2" value="files">
                <Files /> 文件
              </TabsTab>
            </TabsList>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="conversation"
            >
              <Conversation
                agents={agents}
                canEditQueue
                channel={runId}
                closedReopenable
                findCurrentModelId={findCurrentModelId}
                loadMessages={loadMessages}
                sendMessage={sendMessage}
                status={run.status}
                streamPath={`/api/runs/${runId}/stream`}
                switchModel={switchModel}
                setQueue={setQueue}
                thinkingLevel={run.thinkingLevel}
              />
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
                files={{
                  key: (p) => keys.runs.files(runId, p),
                  get: (p) => runsApi.getRunFile(runId, p),
                  downloadUrl: (p) =>
                    `/api/runs/${runId}/files/download?path=${encodeURIComponent(p)}`,
                }}
                key={runId}
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
  eventId: string
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.all }),
  ])
}
