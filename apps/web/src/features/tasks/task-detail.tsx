import {
  Files,
  LayoutPanelTop,
  MessageSquare,
  MessagesSquare,
  SlidersHorizontal,
} from "lucide-react"

import type { Challenge, FleetInfo, QueueItem, QueueState } from "@/api"
import { challengesApi, keys } from "@/api"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { SchedulerConfigTab } from "@/features/events/scheduler-config-tab"
import { SchedulerDmTab } from "@/features/events/scheduler-dm-tab"
import { ChannelsView } from "@/features/runs/channels-view"
import { FilesWorkspace } from "@/features/runs/files-workspace"

import { ConversationPane } from "./conversation-pane"
import { OverviewPane } from "./overview-pane"
import { ORCH } from "./task-list"

export type TaskTab =
  | "overview"
  | "conversation"
  | "channels"
  | "files"
  | "config"

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
  /** The event's queue snapshot (scheduler-overview plan section). */
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

  return (
    <Tabs
      className="flex h-full min-h-0 min-w-0 flex-col"
      onValueChange={(value) => onTabChange(value as TaskTab)}
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
        </TabsTab>
        <TabsTab className="gap-2" value="files">
          <Files /> 文件
        </TabsTab>
        {isScheduler && (
          <TabsTab className="gap-2" value="config">
            <SlidersHorizontal /> 配置
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
          queue={queue}
          schedulerAgent={fleet.schedulerAgent}
          onOpenConfig={() => onTabChange("config")}
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
        <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="config">
          <SchedulerConfigTab eventId={eventId} />
        </TabsPanel>
      )}
    </Tabs>
  )
}
