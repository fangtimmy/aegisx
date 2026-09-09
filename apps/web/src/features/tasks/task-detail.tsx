import { useQuery } from "@tanstack/react-query"
import {
  Files,
  LayoutPanelTop,
  ListOrdered,
  MessageSquare,
  MessagesSquare,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { channelsApi, challengesApi, keys } from "@/api"
import type { Challenge, FleetInfo, QueueItem, QueueState } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { POLL_INTERVAL_MS } from "@/features/events/event-agents-shared"
import { SchedulerDmTab } from "@/features/events/scheduler-dm-tab"
import { ChannelsView } from "@/features/runs/channels-view"
import { FilesWorkspace } from "@/features/runs/files-workspace"

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

const CHANNEL_SEEN_KEY = "aegisx:channel-seen"

function readSeenMap(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(CHANNEL_SEEN_KEY) ?? "{}"
    )
    if (typeof parsed !== "object" || parsed === null) return {}
    const map: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") map[key] = value
    }
    return map
  } catch {
    return {}
  }
}

/** Unread marker on the 频道 tab: channels whose latest message postdates the
 * locally persisted seen marker (server cursors belong to agents, not the
 * human viewer). First sighting seeds a marker so history never counts as
 * unread; while the tab is open everything visible counts as seen. */
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
  const [seen, setSeen] = useState<Record<string, number>>(readSeenMap)
  const items = useMemo(() => channels.data?.items ?? [], [channels.data])

  useEffect(() => {
    if (items.length === 0) return
    const isUnseen = (item: { key: string; lastMessageAt: string | null }) => {
      const marker = seen[item.key]
      if (marker === undefined) return true
      return (
        item.lastMessageAt !== null && Date.parse(item.lastMessageAt) > marker
      )
    }
    // Open tab: only channels with genuinely newer messages need re-marking
    // (marking unconditionally would write → setState → write, forever).
    const missing = (
      active
        ? items.filter(isUnseen)
        : items.filter((item) => seen[item.key] === undefined)
    ).map((item) => item.key)
    if (missing.length === 0) return
    const now = Date.now()
    const next = { ...seen }
    for (const key of missing) next[key] = now
    localStorage.setItem(CHANNEL_SEEN_KEY, JSON.stringify(next))
    setSeen(next)
  }, [active, items, seen])

  // Hidden until every channel carries a marker: the seeding render must not
  // flash a full unread count.
  const unread = items.every((item) => seen[item.key] !== undefined)
    ? items.filter(
        (item) =>
          item.lastMessageAt !== null &&
          Date.parse(item.lastMessageAt) > (seen[item.key] ?? 0)
      ).length
    : 0
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
