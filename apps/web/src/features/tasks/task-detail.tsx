import { useQuery } from "@tanstack/react-query"
import {
  Files,
  LayoutPanelTop,
  ListOrdered,
  MessageSquare,
  MessagesSquare,
} from "lucide-react"
import { useEffect, useMemo } from "react"

import { channelsApi, challengesApi, keys } from "@/api"
import type { Challenge, FleetInfo, QueueItem, QueueState } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { POLL_INTERVAL_MS } from "@/features/events/event-agents-shared"
import { SchedulerDmTab } from "@/features/events/scheduler-dm-tab"
import { ChannelsView } from "@/features/runs/channels-view"
import { FilesWorkspace } from "@/features/runs/files-workspace"
import { useChannelSeen } from "@/features/runs/use-channel-seen"

import { ConversationPane } from "./conversation-pane"
import { OverviewPane } from "./overview-pane"
import { SchedulerQueueTab } from "./scheduler-queue-tab"
import { ORCH } from "./task-list"

export type TaskTab =
  | "overview"
  | "conversation"
  | "channels"
  | "files"
  | "queue"

const TASK_TAB_VALUES = [
  "overview",
  "conversation",
  "channels",
  "files",
  "queue",
] as const

export function isTaskTab(value: string): value is TaskTab {
  return TASK_TAB_VALUES.some((tab) => tab === value)
}

/** Unread marker on the 频道 tab: channels whose latest message postdates the
 * locally persisted seen marker (server cursors belong to agents, not the
 * human viewer). First sighting seeds a baseline so history never counts as
 * unread; while the tab is open everything visible counts as seen. Same
 * store as the channel rail — the two badges cannot disagree. */
function ChannelsTabBadge({
  active,
  challengeId,
}: {
  active: boolean
  challengeId: string | null
}) {
  const channels = useQuery({
    enabled: challengeId !== null,
    queryKey: keys.challenges.channels(challengeId ?? ""),
    queryFn: () => channelsApi.getChallengeChannels(challengeId ?? ""),
    refetchInterval: POLL_INTERVAL_MS,
  })
  const items = useMemo(() => channels.data?.items ?? [], [channels.data])
  const { isUnread, markSeen } = useChannelSeen(items)

  // markSeen no-ops while a marker already covers the activity, so polling
  // with the tab open never write → render → writes.
  useEffect(() => {
    if (!active) return
    for (const item of items) markSeen(item)
  }, [active, items, markSeen])

  const unread = items.filter(isUnread).length
  if (unread === 0) return null
  return (
    <Badge size="sm" variant="info">
      {unread}
    </Badge>
  )
}

/** The right pane: one tab container per selection. The tab set switches
 * with the variant (challenge vs scheduler); the tab state itself lives in
 * the page shell so sibling panes can switch to the conversation tab. */
export function TaskDetail({
  eventId,
  fleet,
  queue,
  challenge,
  selection,
  tab,
  onTabChange,
  onSelectAgent,
  onClearAgent,
}: {
  eventId: string
  fleet: FleetInfo
  /** The event's queue snapshot (scheduler-only queue tab). */
  queue: { items: QueueItem[]; state: QueueState }
  /** Event-detail metadata for the selected challenge (may briefly lag
   * behind the fleet poll; the fleet lite row covers name/category). */
  challenge?: Challenge
  selection: { a: string | null; c: string }
  tab: TaskTab
  onTabChange: (tab: TaskTab) => void
  onSelectAgent: (agentId: string) => void
  onClearAgent: () => void
}) {
  const isScheduler = selection.c === ORCH
  const challengeId = isScheduler ? null : selection.c
  const lite = challengeId
    ? fleet.challenges.find((item) => item.id === challengeId)
    : undefined
  const agents = isScheduler ? [] : (fleet.agentsByChallenge[selection.c] ?? [])
  const pendingCount = isScheduler
    ? 0
    : queue.items.filter(
        (item) => item.challengeId === challengeId && item.status === "pending"
      ).length

  return (
    <Tabs
      className="flex h-full min-h-0 min-w-0 flex-col"
      onValueChange={(value) => {
        if (isTaskTab(value)) onTabChange(value)
      }}
      value={tab}
    >
      <TabsList
        className="w-auto shrink-0 justify-start border-b px-3"
        variant="underline"
      >
        <TabsTab className="gap-2" value="overview">
          <LayoutPanelTop /> 概览
        </TabsTab>
        <TabsTab className="gap-2" value="conversation">
          <MessageSquare /> 对话
        </TabsTab>
        <TabsTab className="gap-2" value="channels">
          <MessagesSquare /> 频道
          <ChannelsTabBadge
            active={tab === "channels"}
            challengeId={isScheduler ? null : selection.c}
          />
        </TabsTab>
        <TabsTab className="gap-2" value="files">
          <Files /> 文件
        </TabsTab>
        {isScheduler && (
          <TabsTab className="gap-2" value="queue">
            <ListOrdered /> 队列
          </TabsTab>
        )}
      </TabsList>
      <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="overview">
        <OverviewPane
          agents={agents}
          challenge={challenge}
          config={fleet.config}
          eventId={eventId}
          lite={lite}
          pendingCount={pendingCount}
          schedulerAgent={fleet.schedulerAgent}
          onSelectAgent={onSelectAgent}
        />
      </TabsPanel>
      <TabsPanel
        className="min-h-0 flex-1 overflow-hidden"
        value="conversation"
      >
        <ConversationPane
          agentId={selection.a}
          agents={agents}
          challenge={challenge ?? lite}
          eventId={eventId}
          schedulerAgent={fleet.schedulerAgent}
          onClearAgent={onClearAgent}
          onSelectAgent={onSelectAgent}
        />
      </TabsPanel>
      <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="channels">
        {isScheduler ? (
          <SchedulerDmTab active={tab === "channels"} eventId={eventId} />
        ) : challengeId ? (
          <ChannelsView challengeId={challengeId} />
        ) : null}
      </TabsPanel>
      <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="files">
        {challengeId ? (
          <FilesWorkspace
            enabled={tab === "files"}
            files={{
              key: (path) => keys.challenges.files(challengeId, path),
              get: (path) => challengesApi.getChallengeFiles(challengeId, path),
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
      {isScheduler && (
        <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="queue">
          <SchedulerQueueTab
            eventId={eventId}
            onOpenAgent={onSelectAgent}
            queue={queue}
          />
        </TabsPanel>
      )}
    </Tabs>
  )
}
