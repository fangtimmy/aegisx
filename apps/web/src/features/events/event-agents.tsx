import { useQuery } from "@tanstack/react-query"
import {
  ClipboardList,
  ListChecks,
  ListOrdered,
  Puzzle,
  Users,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router"

import type { AgentSummary, Challenge, QueueItem, RunPublic } from "@/api"
import { keys, runsApi, schedulerApi } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardPanel } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"

import { AgentDialog } from "./agent-dialog"
import { AgentsGraph } from "./agents-graph"
import { AgentsTab } from "./agents-tab"
import { ChallengesTreeTab } from "./challenges-tree-tab"
import {
  POLL_INTERVAL_MS,
  type SchedulerWithAgents,
} from "./event-agents-shared"
import { ErrorState } from "./event-shared"
import { QueueList } from "./queue-list"
import { RunsTab } from "./runs-tab"
import { TimelineTab } from "./timeline-tab"

type OverviewTab = "plan" | "timeline" | "challenges" | "runs" | "agents"

function PlanPanel({
  eventId,
  queue,
}: {
  eventId: string
  queue: QueueItem[]
}) {
  const navigate = useNavigate()
  const visibleQueue = queue.filter((item) =>
    ["pending", "running", "failed"].includes(item.status)
  )
  if (visibleQueue.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>计划队列为空</EmptyTitle>
          <EmptyDescription>
            调度者尚未规划任务。在「题目」中开启任务，或启动调度者让它自行排程。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-3 p-1">
        <div className="flex items-center gap-2 p-1">
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            计划队列
          </h3>
          <Badge size="sm" variant="secondary">
            {visibleQueue.length}
          </Badge>
        </div>
        <Card>
          <CardPanel className="p-0">
            <QueueList
              eventId={eventId}
              items={visibleQueue}
              onOpenRun={(runId) =>
                navigate(`/events/${eventId}/runs/${runId}`)
              }
            />
          </CardPanel>
        </Card>
      </div>
    </ScrollArea>
  )
}

export function EventAgents({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
  const [tab, setTab] = useState<OverviewTab>("agents")
  const [selection, setSelection] = useState<{
    runId: string
    agentId: string
  } | null>(null)
  const onSelectAgent = useCallback((runId: string, agentId: string) => {
    setSelection({ runId, agentId })
  }, [])

  // Fleet: every challenge run + its agents (the overview's single source of
  // truth). Always polls — the scheduler can start/stop runs server-side at
  // any time, so the overview must stay current unconditionally.
  const fleet = useQuery({
    queryKey: keys.runs.fleet(eventId),
    queryFn: async () => {
      const items = (await runsApi.listEventRuns(eventId)).items
      const details = await Promise.all(
        items.map((run) => runsApi.getRun(run.id))
      )
      return { items, details }
    },
    refetchInterval: POLL_INTERVAL_MS,
  })
  // Scheduler (event-scoped run) + its agents; the queue snapshot.
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: async (): Promise<SchedulerWithAgents> => {
      const data = await schedulerApi.getScheduler(eventId)
      const agents = data.run ? (await runsApi.getRun(data.run.id)).agents : []
      return { ...data, agents }
    },
    refetchInterval: POLL_INTERVAL_MS,
  })
  const queue = useQuery({
    queryKey: keys.scheduler.queue(eventId),
    queryFn: () => schedulerApi.listQueue(eventId),
    // Always poll: launch progress (pending → running → done) and edits stay
    // current without manual refreshes.
    refetchInterval: POLL_INTERVAL_MS,
  })
  const detailsById = useMemo(() => {
    const map = new Map<string, { run: RunPublic; agents: AgentSummary[] }>()
    for (const detail of fleet.data?.details ?? [])
      map.set(detail.run.id, detail)
    return map
  }, [fleet.data])

  if (fleet.isPending || scheduler.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载 Agents…
      </div>
    )
  }
  if (fleet.error) {
    return <ErrorState error={fleet.error} retry={() => fleet.refetch()} />
  }

  const runs = fleet.data?.items ?? []
  const schedulerData = scheduler.data

  return (
    <div className="grid h-full min-h-0 grid-cols-[24rem_minmax(0,1fr)] gap-4">
      <div className="flex min-h-0 min-w-0 flex-col">
        <Tabs className="min-h-0 flex-1" onValueChange={setTab} value={tab}>
          <TabsList className="w-auto justify-start" variant="underline">
            <TabsTab className="gap-1.5" value="plan">
              <ClipboardList /> 计划
            </TabsTab>
            <TabsTab className="gap-1.5" value="timeline">
              <ListChecks /> 时间线
            </TabsTab>
            <TabsTab className="gap-1.5" value="challenges">
              <Puzzle /> 题目
            </TabsTab>
            <TabsTab className="gap-1.5" value="runs">
              <ListOrdered /> 任务
            </TabsTab>
            <TabsTab className="gap-1.5" value="agents">
              <Users /> Agents
            </TabsTab>
          </TabsList>
          <div className="mt-2 min-h-0 flex-1">
            <TabsPanel className="h-full" value="plan">
              <PlanPanel eventId={eventId} queue={queue.data?.items ?? []} />
            </TabsPanel>
            <TabsPanel className="h-full" value="timeline">
              <TimelineTab
                challenges={challenges}
                eventId={eventId}
                runs={runs}
              />
            </TabsPanel>
            <TabsPanel className="h-full" value="challenges">
              <ChallengesTreeTab challenges={challenges} />
            </TabsPanel>
            <TabsPanel className="h-full" value="runs">
              <RunsTab runs={runs} />
            </TabsPanel>
            <TabsPanel className="h-full" value="agents">
              <AgentsTab
                detailsById={detailsById}
                onSelectAgent={onSelectAgent}
                runs={runs}
                scheduler={schedulerData}
              />
            </TabsPanel>
          </div>
        </Tabs>
      </div>
      <AgentsGraph
        detailsById={detailsById}
        eventId={eventId}
        onSelectAgent={onSelectAgent}
        runs={runs}
        scheduler={schedulerData}
      />
      {selection && (
        <AgentDialog
          agentId={selection.agentId}
          onClose={() => setSelection(null)}
          runId={selection.runId}
        />
      )}
    </div>
  )
}
