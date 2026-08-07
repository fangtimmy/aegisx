import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  CircleAlert,
  Files,
  Info,
  MessageSquare,
  Square,
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

import { Conversation } from "./conversation"
import { CreateRunDialog } from "./create-run-dialog"
import { FilesWorkspace } from "./files-workspace"
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
            <Button
              loading={close.isPending}
              onClick={() => close.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Archive /> 关闭
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
                <Square /> 停止
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>停止该任务？</AlertDialogTitle>
                  <AlertDialogDescription>
                    当前轮次将被取消（类似按
                    Esc）。容器会保留；发送消息即可继续。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    取消
                  </AlertDialogClose>
                  <Button
                    loading={stop.isPending}
                    onClick={() => stop.mutate()}
                    type="button"
                    variant="destructive"
                  >
                    停止任务
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
              <Conversation agents={agents} run={run} runId={runId} />
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
