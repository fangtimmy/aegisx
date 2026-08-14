import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Files,
  MessageSquare,
  Settings2,
  SlidersHorizontal,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { agentsApi, keys, type ModelRef, runsApi } from "@/api"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { Conversation } from "@/features/runs/conversation"
import { FilesWorkspace } from "@/features/runs/files-workspace"
import { RunOverview } from "@/features/runs/run-overview"

import { POLL_INTERVAL_MS, roleLabel } from "./event-agents-shared"
import { SchedulerConfigTab } from "./scheduler-config-tab"

export function AgentDialog({
  runId,
  agentId,
  onClose,
}: {
  runId: string
  agentId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: keys.runs.detail(runId),
    queryFn: () => runsApi.getRun(runId),
    // Poll while running so the composer's send→stop swap and the dialog
    // status stay live (the fleet query doesn't feed this cache key).
    refetchInterval: (query) =>
      query.state.data && query.state.data.run.status === "running"
        ? POLL_INTERVAL_MS
        : false,
  })
  const [view, setView] = useState<
    "conversation" | "files" | "overview" | "config"
  >("conversation")

  const run = detail.data?.run
  const agents = detail.data?.agents ?? []
  const agent = agents.find((item) => item.id === agentId)

  // Conversation adapter — declared before the loading guard so hooks are
  // not placed behind a conditional return (Rules-of-hooks). The callbacks
  // are only invoked once run/agent are defined, so the optional chaining in
  // the deps is safe.
  const sendMessage = useCallback(
    (id: string, text: string, deliverAs?: "steer" | "followUp") =>
      agentsApi.sendMessage(id, { text, deliverAs }),
    []
  )
  const switchModel = useCallback(
    (id: string, ref: ModelRef) =>
      agentsApi.switchModel(id, { model: ref }).then(() =>
        queryClient.invalidateQueries({
          queryKey: keys.runs.fleet(run?.eventId ?? ""),
        })
      ),
    [run?.eventId, queryClient]
  )
  const loadMessages = useCallback(
    () => runsApi.listMessages(runId, 0, agentId).then((list) => list.items),
    [runId, agentId]
  )

  // Agent-level controls now live in the composer: stop (send→stop swap),
  // compact (/compact), close (/close). The header is identity-only; the
  // graph only hosts the scheduler start entry.
  const invalidateAgent = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) }),
        queryClient.invalidateQueries({
          queryKey: keys.runs.fleet(run?.eventId ?? ""),
        }),
      ]),
    [queryClient, runId, run?.eventId]
  )
  // Multi-session + flat backtrack (v12): per-agent session ops (orchestrator
  // included — it is a main agent served by the same run service).
  const sessionOps = useMemo(
    () => ({
      listSessions: (id: string) =>
        agentsApi.listSessions(id).then((r) => r.items),
      createSession: (id: string) =>
        agentsApi.createSession(id).then(() => invalidateAgent()),
      activateSession: (id: string, sessionId: string) =>
        agentsApi.activateSession(id, sessionId).then(() => invalidateAgent()),
      backtrack: (id: string, seq: number) =>
        agentsApi.backtrack(id, seq).then(() => invalidateAgent()),
    }),
    [invalidateAgent]
  )
  // Silent host callbacks for the composer: stop (send→stop swap) + close
  // (/close). Toasts live at the Conversation call site.
  const stopAgent = useCallback(
    (id: string) => agentsApi.stopAgent(id).then(() => invalidateAgent()),
    [invalidateAgent]
  )
  const closeRun = useCallback(
    () => runsApi.closeRun(runId).then(() => invalidateAgent()),
    [runId, invalidateAgent]
  )
  // Shared compact action (composer /compact command); toasts live at the
  // Conversation call site.
  const compactRun = useCallback(
    () => agentsApi.compactAgent(agentId).then(() => invalidateAgent()),
    [agentId, invalidateAgent]
  )

  if (detail.isPending || !run || !agent) {
    return (
      <Dialog onOpenChange={(open) => !open && onClose()} open>
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Agent</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner aria-hidden="true" />
              正在加载…
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    )
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup className="flex h-[min(85svh,52rem)] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>
            <span className="flex min-w-0 items-center gap-2">
              <AgentStatusIcon status={agent.status} />
              <span className="truncate">
                {agent.name ?? roleLabel(agent.role)}
              </span>
              <Badge size="sm" variant="secondary">
                {roleLabel(agent.role)}
              </Badge>
            </span>
          </DialogTitle>
          <DialogDescription className="truncate">
            {run.scopeType === "event" ? "调度者任务" : run.challengeName}
            {" · "}
            {run.provider} / {run.modelId}
            {agent.isEntry ? " · 入口" : ""}
          </DialogDescription>
        </DialogHeader>
        {/* Plain flex div, NOT DialogPanel: DialogPanel wraps its children in
            a ScrollArea, which would scroll the tab bar and the composer
            along with the content. We need the TabsList pinned at top and
            (for the conversation tab) the composer pinned at bottom, so the
            body owns the flex layout and each panel scrolls itself (the
            layout formerly shared with run-workspace's CardPanel). */}
        <div className="flex min-h-0 flex-1 flex-col">
          <Tabs
            className="flex h-full min-h-0 min-w-0 flex-col"
            onValueChange={(value) =>
              setView(value as "conversation" | "files" | "overview" | "config")
            }
            value={view}
          >
            <TabsList
              className="mx-6 w-auto shrink-0 justify-start border-b"
              variant="underline"
            >
              <TabsTab className="gap-2" value="conversation">
                <MessageSquare /> 对话
              </TabsTab>
              <TabsTab className="gap-2" value="files">
                <Files /> 文件
              </TabsTab>
              <TabsTab className="gap-2" value="overview">
                <Settings2 /> 概览
              </TabsTab>
              {run.scopeType === "event" && (
                <TabsTab className="gap-2" value="config">
                  <SlidersHorizontal /> 配置
                </TabsTab>
              )}
            </TabsList>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="conversation"
            >
              <Conversation
                agents={[agent]}
                canEditQueue={false}
                channel={runId}
                closedReopenable
                closeRun={closeRun}
                compactAgent={compactRun}
                key={`${runId}:${agentId}`}
                loadMessages={loadMessages}
                sendMessage={sendMessage}
                sessionOps={sessionOps}
                status={run.status}
                stopAgent={stopAgent}
                streamPath={`/api/runs/${runId}/stream`}
                switchModel={switchModel}
              />
            </TabsPanel>
            <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="files">
              <FilesWorkspace
                enabled={view === "files"}
                files={{
                  key: (path) => keys.runs.files(runId, path),
                  get: (path) => runsApi.getRunFile(runId, path),
                  downloadUrl: (path) =>
                    `/api/runs/${runId}/files/download?path=${encodeURIComponent(path)}`,
                }}
                key={runId}
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
            {run.scopeType === "event" && (
              <TabsPanel
                className="min-h-0 flex-1 overflow-hidden"
                value="config"
              >
                <SchedulerConfigTab eventId={run.eventId} />
              </TabsPanel>
            )}
          </Tabs>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
