import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Files,
  Inbox,
  MessageSquare,
  MessagesSquare,
  Settings2,
  SlidersHorizontal,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { agentsApi, challengesApi, keys, type ModelRef } from "@/api"
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
import { AgentOverview } from "@/features/runs/agent-overview"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { ChannelsView } from "@/features/runs/channels-view"
import { Conversation } from "@/features/runs/conversation"
import { FilesWorkspace } from "@/features/runs/files-workspace"

import { POLL_INTERVAL_MS, roleLabel } from "./event-agents-shared"
import { SchedulerConfigTab } from "./scheduler-config-tab"
import { SchedulerDmTab } from "./scheduler-dm-tab"

export function AgentDialog({
  agentId,
  onClose,
}: {
  agentId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: keys.agents.detail(agentId),
    queryFn: () => agentsApi.getAgent(agentId),
    // Poll while running so the composer's send→stop swap and the dialog
    // status stay live (the fleet query doesn't feed this cache key).
    refetchInterval: (query) =>
      query.state.data && query.state.data.agent.status === "running"
        ? POLL_INTERVAL_MS
        : false,
  })
  const [view, setView] = useState<
    "conversation" | "files" | "channels" | "overview" | "config" | "inbox"
  >("conversation")

  const agent = detail.data?.agent

  // Conversation adapter — declared before the loading guard so hooks are
  // not placed behind a conditional return (Rules-of-hooks). The callbacks
  // are only invoked once the agent is defined.
  const sendMessage = useCallback(
    (text: string, deliverAs?: "steer" | "followUp") =>
      agentsApi.sendMessage(agentId, { text, deliverAs }),
    [agentId]
  )
  const switchModel = useCallback(
    (ref: ModelRef) =>
      agentsApi.switchModel(agentId, { model: ref }).then(() =>
        queryClient.invalidateQueries({
          queryKey: keys.agents.fleet(agent?.eventId ?? ""),
        })
      ),
    [agent?.eventId, queryClient, agentId]
  )
  const loadMessages = useCallback(
    () => agentsApi.listMessages(agentId).then((list) => list.items),
    [agentId]
  )

  const invalidateAgent = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.agents.detail(agentId),
        }),
        queryClient.invalidateQueries({
          queryKey: keys.agents.fleet(agent?.eventId ?? ""),
        }),
      ]),
    [queryClient, agentId, agent?.eventId]
  )
  // Multi-session + flat backtrack (v12): per-agent session ops.
  const sessionOps = useMemo(
    () => ({
      listSessions: () => agentsApi.listSessions(agentId).then((r) => r.items),
      createSession: () =>
        agentsApi.createSession(agentId).then(() => invalidateAgent()),
      activateSession: (sessionId: string) =>
        agentsApi
          .activateSession(agentId, sessionId)
          .then(() => invalidateAgent()),
      backtrack: (seq: number) =>
        agentsApi.backtrack(agentId, seq).then(() => invalidateAgent()),
    }),
    [invalidateAgent, agentId]
  )
  const stopAgent = useCallback(
    () => agentsApi.stopAgent(agentId).then(() => invalidateAgent()),
    [invalidateAgent, agentId]
  )
  const closeAgent = useCallback(
    () => agentsApi.closeAgent(agentId).then(() => invalidateAgent()),
    [invalidateAgent, agentId]
  )
  const compactAgent = useCallback(
    () => agentsApi.compactAgent(agentId).then(() => invalidateAgent()),
    [invalidateAgent, agentId]
  )

  // #12: data arrived but the agent is gone → tell the user + close.
  if (detail.isPending) {
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
  if (detail.error || !agent) {
    return (
      <Dialog onOpenChange={(open) => !open && onClose()} open>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Agent 不存在</DialogTitle>
            <DialogDescription>
              该 agent 可能已被删除，或数据未到达。请刷新事件视图后重试。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <button
              className="w-full rounded-md border px-3 py-2 text-sm hover:bg-secondary"
              onClick={onClose}
              type="button"
            >
              关闭
            </button>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    )
  }

  const isScheduler = agent.role === "orchestrator"
  const challengeId = agent.challengeId

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
            {isScheduler ? "调度者任务" : agent.challengeName}
            {" · "}
            {agent.model ?? "默认模型"}
          </DialogDescription>
        </DialogHeader>
        {/* Plain flex div, NOT DialogPanel: DialogPanel wraps its children in
            a ScrollArea, which would scroll the tab bar and the composer
            along with the content. We need the TabsList pinned at top and
            (for the conversation tab) the composer pinned at bottom, so the
            body owns the flex layout and each panel scrolls itself. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <Tabs
            className="flex h-full min-h-0 min-w-0 flex-col"
            onValueChange={(value) =>
              setView(
                value as
                  | "conversation"
                  | "files"
                  | "channels"
                  | "overview"
                  | "config"
                  | "inbox"
              )
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
              {!isScheduler && (
                <TabsTab className="gap-2" value="channels">
                  <MessagesSquare /> 频道
                </TabsTab>
              )}
              <TabsTab className="gap-2" value="files">
                <Files /> 文件
              </TabsTab>
              <TabsTab className="gap-2" value="overview">
                <Settings2 /> 概览
              </TabsTab>
              {isScheduler && (
                <TabsTab className="gap-2" value="config">
                  <SlidersHorizontal /> 配置
                </TabsTab>
              )}
              {isScheduler && (
                <TabsTab className="gap-2" value="inbox">
                  <Inbox /> 调度 DM
                </TabsTab>
              )}
            </TabsList>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="conversation"
            >
              <Conversation
                agent={agent}
                detail={detail.data ?? undefined}
                canEditQueue={false}
                closedReopenable
                closeAgent={closeAgent}
                compactAgent={compactAgent}
                key={agentId}
                loadMessages={loadMessages}
                sendMessage={sendMessage}
                sessionOps={sessionOps}
                status={
                  agent.status === "running"
                    ? "running"
                    : agent.status === "idle"
                      ? "idle"
                      : "closed"
                }
                stopAgent={stopAgent}
                streamPath={`/api/agents/${agentId}/stream`}
                switchModel={switchModel}
              />
            </TabsPanel>
            {!isScheduler && challengeId && (
              <TabsPanel
                className="min-h-0 flex-1 overflow-hidden"
                value="channels"
              >
                <ChannelsView challengeId={challengeId} />
              </TabsPanel>
            )}
            <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="files">
              {challengeId && agent.eventId ? (
                <FilesWorkspace
                  enabled={view === "files"}
                  files={{
                    key: (path) => keys.challenges.files(challengeId, path),
                    get: (path) =>
                      challengesApi.getChallengeFiles(challengeId, path),
                    downloadUrl: (path) =>
                      `/api/challenges/${challengeId}/files/download?path=${encodeURIComponent(path)}`,
                  }}
                  key={challengeId}
                />
              ) : (
                <p className="px-6 py-4 text-sm text-muted-foreground">
                  调度者无题工作区文件。
                </p>
              )}
            </TabsPanel>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="overview"
            >
              <ScrollArea className="h-full" scrollFade>
                <AgentOverview detail={detail.data!} />
              </ScrollArea>
            </TabsPanel>
            {isScheduler && (
              <TabsPanel
                className="min-h-0 flex-1 overflow-hidden"
                value="config"
              >
                <SchedulerConfigTab eventId={agent.eventId} />
              </TabsPanel>
            )}
            {isScheduler && (
              <TabsPanel
                className="min-h-0 flex-1 overflow-hidden"
                value="inbox"
              >
                <SchedulerDmTab
                  active={view === "inbox"}
                  eventId={agent.eventId}
                />
              </TabsPanel>
            )}
          </Tabs>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
