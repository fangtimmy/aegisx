import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Files,
  Flag,
  GitFork,
  LayoutPanelTop,
  ListChecks,
  ListOrdered,
  MessageSquare,
  Network,
  Play,
  Puzzle,
  Server,
  Settings2,
  Timer,
  Users,
} from "lucide-react"
import { type ReactNode, useCallback, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"

import {
  type AgentSummary,
  agentsApi,
  type Challenge,
  keys,
  type QueueItem,
  type RunPublic,
  runsApi,
  schedulerApi,
  type SchedulerInfo,
  type ThinkingLevel,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { Conversation } from "@/features/runs/conversation"
import { FilesWorkspace } from "@/features/runs/files-workspace"
import { type AvailableModel } from "@/features/runs/model-switcher"
import {
  RunOverview,
  runStatusLabel,
  statusVariant,
} from "@/features/runs/run-overview"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

import { ErrorState, isChallengeSolved } from "./event-shared"
import { QueueList } from "./queue-list"

const UNCATEGORIZED = "未分类"

const ROLE_LABELS: Record<string, string> = {
  solver: "求解者",
  observer: "观察者",
  orchestrator: "调度者",
  child: "子代理",
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

type OverviewTab = "summary" | "timeline" | "challenges" | "runs" | "agents"

/** Scheduler endpoint payload + its run's agents (fetched in one query). */
type SchedulerWithAgents = SchedulerInfo & { agents: AgentSummary[] }

/** An agent + the run it belongs to (for cross-run aggregation). */
type AgentRef = { agent: AgentSummary; run: RunPublic }

export function EventOverview({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
  const [tab, setTab] = useState<OverviewTab>("summary")
  const [selection, setSelection] = useState<{
    runId: string
    agentId: string
  } | null>(null)

  // Fleet: every challenge run + its agents (the overview's single source of
  // truth). Polls while any run is active so statuses stay current.
  const fleet = useQuery({
    queryKey: keys.runs.fleet(eventId),
    queryFn: async () => {
      const items = (await runsApi.listEventRuns(eventId)).items
      const details = await Promise.all(
        items.map((run) => runsApi.getRun(run.id))
      )
      return { items, details }
    },
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => run.status === "running")
        ? 5000
        : false,
  })
  // Scheduler (event-scoped run) + its agents; the queue snapshot.
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: async (): Promise<SchedulerWithAgents> => {
      const data = await schedulerApi.getScheduler(eventId)
      const agents = data.run ? (await runsApi.getRun(data.run.id)).agents : []
      return { ...data, agents }
    },
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 5000 : false,
  })
  const queue = useQuery({
    queryKey: keys.scheduler.queue(eventId),
    queryFn: () => schedulerApi.listQueue(eventId),
    // Poll while anything is pending/running so launch progress (pending →
    // running → done) and edits stay current without manual refreshes.
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((item) =>
        ["pending", "running"].includes(item.status)
      )
        ? 5000
        : false,
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
        正在加载概览…
      </div>
    )
  }
  if (fleet.error) {
    return <ErrorState error={fleet.error} retry={() => fleet.refetch()} />
  }

  const runs = fleet.data?.items ?? []
  const schedulerData = scheduler.data

  const onSelectAgent = useCallback((runId: string, agentId: string) => {
    setSelection({ runId, agentId })
  }, [])

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_22rem] gap-4">
      <div className="flex min-h-0 min-w-0 flex-col">
        <Tabs onValueChange={setTab} value={tab}>
          <TabsList className="w-auto justify-start" variant="underline">
            <TabsTab className="gap-1.5" value="summary">
              <LayoutPanelTop /> 总览
            </TabsTab>
            <TabsTab className="gap-1.5" value="timeline">
              <ListChecks /> Timeline
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
            <TabsPanel className="h-full" value="summary">
              <SummaryTab
                challenges={challenges}
                detailsById={detailsById}
                onSelectAgent={onSelectAgent}
                runs={runs}
                scheduler={schedulerData}
                queue={queue.data?.items ?? []}
              />
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
              <RunsTab
                eventId={eventId}
                queue={queue.data?.items ?? []}
                runs={runs}
              />
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

// --- 总览 -----------------------------------------------------------------

function SummaryTab({
  challenges,
  runs,
  detailsById,
  scheduler,
  queue,
  onSelectAgent,
}: {
  challenges: Challenge[]
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  queue: QueueItem[]
  onSelectAgent: (runId: string, agentId: string) => void
}) {
  const solved = challenges.filter(isChallengeSolved).length
  const total = challenges.length
  const solvedPercent = total > 0 ? Math.round((solved / total) * 100) : 0
  const activeRuns = runs.filter((run) => run.status !== "closed")
  const pendingQueue = queue.filter((item) => item.status === "pending")

  const activeAgents: AgentRef[] = []
  for (const run of activeRuns) {
    for (const agent of detailsById.get(run.id)?.agents ?? []) {
      activeAgents.push({ agent, run })
    }
  }

  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-4 p-1">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>解题进度</CardFrameTitle>
            <CardFrameDescription>
              {solved} / {total} 已解决
            </CardFrameDescription>
          </CardFrameHeader>
          <CardPanel className="pt-0">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-success transition-all"
                style={{ width: `${solvedPercent}%` }}
              />
            </div>
          </CardPanel>
        </CardFrame>

        <div className="grid grid-cols-2 gap-3">
          <StatCard
            icon={<Play className="size-4" />}
            label="活跃任务"
            value={String(activeRuns.length)}
          />
          <StatCard
            icon={<ListOrdered className="size-4" />}
            label="排队中"
            value={String(pendingQueue.length)}
          />
          <StatCard
            icon={<BrainCircuit className="size-4" />}
            label="活跃 Agents"
            value={String(activeAgents.length)}
          />
          <StatCard
            icon={<Network className="size-4" />}
            label="调度者"
            value={
              scheduler?.run ? runStatusLabel(scheduler.run.status) : "未启用"
            }
          />
        </div>

        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>活跃 Agents</CardFrameTitle>
          </CardFrameHeader>
          <CardPanel className="p-0">
            {activeAgents.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                暂无活跃 agent。
              </p>
            ) : (
              <div className="flex flex-col">
                {activeAgents.map(({ agent, run }) => (
                  <button
                    className="flex min-w-0 items-center gap-2.5 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-accent"
                    key={agent.id}
                    onClick={() => onSelectAgent(run.id, agent.id)}
                    type="button"
                  >
                    <AgentStatusIcon
                      className="[&_svg]:size-4"
                      status={agent.status}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {agent.name ?? roleLabel(agent.role)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {run.challengeName}
                      </span>
                    </span>
                    <Badge size="sm" variant="secondary">
                      {roleLabel(agent.role)}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </CardPanel>
        </CardFrame>
      </div>
    </ScrollArea>
  )
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <CardFrame>
      <CardPanel className="gap-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="text-xl font-semibold">{value}</span>
      </CardPanel>
    </CardFrame>
  )
}

// --- Timeline --------------------------------------------------------------

type TimelineEvent = {
  time: string
  id: string
  kind: "run" | "timeout" | "closed" | "flag" | "challenge"
  title: string
  detail: string
  runId?: string
}

function buildTimeline(
  challenges: Challenge[],
  runs: RunPublic[]
): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const challenge of challenges) {
    events.push({
      time: challenge.createdAt,
      id: `ch:${challenge.id}`,
      kind: "challenge",
      title: "添加题目",
      detail: challenge.name,
    })
    for (const flag of challenge.flags) {
      if (flag.status !== "accepted") continue
      events.push({
        time: flag.createdAt,
        id: `flag:${flag.id}`,
        kind: "flag",
        title: "Flag 通过",
        detail: `${challenge.name} · ${flag.flag}`,
        runId: flag.runId ?? undefined,
      })
    }
  }
  for (const run of runs) {
    events.push({
      time: run.createdAt,
      id: `run:${run.id}:created`,
      kind: "run",
      title: "任务启动",
      detail: `${run.challengeName} · ${run.orchestration} · ${
        run.source === "scheduler" ? "调度者" : "手动"
      }`,
      runId: run.id,
    })
    if (run.lastTimeoutAt) {
      // Outcome is not persisted — infer from the run's current state
      // (a timeout with a still-warm run settled to idle; a closed one
      // was SIGKILLed, spec §8.3).
      events.push({
        time: run.lastTimeoutAt,
        id: `run:${run.id}:timeout`,
        kind: "timeout",
        title: "任务超时",
        detail: `${run.challengeName} · ${
          run.status === "closed" ? "超时未恢复，已强制关闭" : "已恢复"
        }`,
        runId: run.id,
      })
    }
    if (run.completedAt) {
      events.push({
        time: run.completedAt,
        id: `run:${run.id}:closed`,
        kind: "closed",
        title: "任务结束",
        detail: `${run.challengeName}${
          run.summary ? ` · ${run.summary.slice(0, 48)}` : ""
        }`,
        runId: run.id,
      })
    }
  }
  return events.sort((left, right) => right.time.localeCompare(left.time))
}

const TIMELINE_ICONS: Record<TimelineEvent["kind"], typeof Play> = {
  run: Play,
  timeout: Timer,
  closed: Archive,
  flag: Flag,
  challenge: Puzzle,
}

function TimelineTab({
  challenges,
  runs,
  eventId,
}: {
  challenges: Challenge[]
  runs: RunPublic[]
  eventId: string
}) {
  const events = useMemo(
    () => buildTimeline(challenges, runs),
    [challenges, runs]
  )
  if (events.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>暂无事件</EmptyTitle>
          <EmptyDescription>
            启动任务后，结构事件将显示在这里。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <ol className="relative flex flex-col p-1">
        {events.map((event) => {
          const Icon = TIMELINE_ICONS[event.kind]
          const row = (
            <span className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border",
                  event.kind === "flag" &&
                    "border-success/30 bg-success/10 text-success",
                  event.kind === "timeout" &&
                    "border-warning/30 bg-warning/10 text-warning",
                  event.kind === "closed" &&
                    "border-border bg-muted text-muted-foreground",
                  event.kind === "run" && "border-info/30 bg-info/10 text-info",
                  event.kind === "challenge" &&
                    "border-border bg-muted text-muted-foreground"
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {event.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {event.detail}
                </span>
              </span>
              <time
                className="shrink-0 text-xs text-muted-foreground"
                dateTime={event.time}
                title={new Date(event.time).toLocaleString()}
              >
                {formatTime(event.time)}
              </time>
            </span>
          )
          return event.runId ? (
            <li className="border-b py-2.5 last:border-b-0" key={event.id}>
              <Link
                className="block rounded-md hover:bg-accent"
                to={`/events/${eventId}/runs/${event.runId}`}
              >
                {row}
              </Link>
            </li>
          ) : (
            <li className="border-b py-2.5 last:border-b-0" key={event.id}>
              {row}
            </li>
          )
        })}
      </ol>
    </ScrollArea>
  )
}

// --- Challenges 树 ---------------------------------------------------------

function ChallengesTreeTab({ challenges }: { challenges: Challenge[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, Challenge[]>()
    for (const challenge of challenges) {
      const category = challenge.category || UNCATEGORIZED
      const list = map.get(category) ?? []
      list.push(challenge)
      map.set(category, list)
    }
    return [...map.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "zh-Hans-CN", { sensitivity: "base" })
    )
  }, [challenges])

  if (challenges.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>暂无题目</EmptyTitle>
          <EmptyDescription>在「题目」标签页添加题目。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-3 p-1">
        {groups.map(([category, items]) => (
          <Collapsible key={category}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform data-panel-open:rotate-90" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {category}
              </span>
              <Badge size="sm" variant="secondary">
                {items.length}
              </Badge>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="flex flex-col">
                {items.map((challenge) => (
                  <ChallengeRow challenge={challenge} key={challenge.id} />
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ))}
      </div>
    </ScrollArea>
  )
}

function ChallengeRow({ challenge }: { challenge: Challenge }) {
  const solved = isChallengeSolved(challenge)
  return (
    <Link
      className="flex min-w-0 items-center gap-2 rounded-md px-7 py-2 hover:bg-accent"
      to={`/events/${challenge.eventId}/challenges`}
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          solved ? "bg-success" : "bg-muted-foreground/40"
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{challenge.name}</span>
      {challenge.points !== null && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {challenge.points}
        </span>
      )}
      {solved && (
        <Badge size="sm" variant="success">
          <Flag /> 已解决
        </Badge>
      )}
    </Link>
  )
}

// --- Runs 列表 --------------------------------------------------------------

function RunsTab({
  eventId,
  runs,
  queue,
}: {
  eventId: string
  runs: RunPublic[]
  queue: QueueItem[]
}) {
  const navigate = useNavigate()
  const activeRuns = runs
    .filter((run) => run.status !== "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const historyRuns = runs
    .filter((run) => run.status === "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const visibleQueue = queue.filter((item) =>
    ["pending", "running", "failed"].includes(item.status)
  )

  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-4 p-1">
        {visibleQueue.length > 0 && (
          <section>
            <div className="flex items-center gap-2 p-1">
              <h3 className="text-xs font-medium text-muted-foreground uppercase">
                任务队列
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
                  onChanged={() => undefined}
                  onOpenRun={(runId) =>
                    navigate(`/events/${eventId}/runs/${runId}`)
                  }
                />
              </CardPanel>
            </Card>
          </section>
        )}
        <section>
          <div className="flex items-center gap-2 p-1">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              活跃任务
            </h3>
            <Badge size="sm" variant="secondary">
              {activeRuns.length}
            </Badge>
          </div>
          {activeRuns.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              暂无活跃任务。
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {activeRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </section>
        {historyRuns.length > 0 && (
          <section>
            <div className="flex items-center gap-2 p-1">
              <h3 className="text-xs font-medium text-muted-foreground uppercase">
                已归档
              </h3>
              <Badge size="sm" variant="secondary">
                {historyRuns.length}
              </Badge>
            </div>
            <div className="flex flex-col gap-1">
              {historyRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}

function RunRow({ run }: { run: RunPublic }) {
  return (
    <Link
      className="group flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2.5 hover:bg-accent"
      to={`/events/${run.eventId}/runs/${run.id}`}
    >
      <span className="shrink-0">
        <Badge size="sm" variant={statusVariant(run.status)}>
          {runStatusLabel(run.status)}
        </Badge>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {run.challengeName}
          </span>
          {run.hasAcceptedFlag && (
            <Badge size="sm" variant="success">
              <Flag />
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
          {run.provider} / {run.modelName}
        </span>
      </span>
      <time
        className="shrink-0 text-xs text-muted-foreground"
        dateTime={run.updatedAt}
        title={new Date(run.updatedAt).toLocaleString()}
      >
        {formatTime(run.updatedAt)}
      </time>
    </Link>
  )
}

// --- Agents 按 role 聚合 ----------------------------------------------------

function AgentsTab({
  runs,
  detailsById,
  scheduler,
  onSelectAgent,
}: {
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  onSelectAgent: (runId: string, agentId: string) => void
}) {
  const allAgents: AgentRef[] = useMemo(() => {
    const refs: AgentRef[] = []
    for (const run of runs) {
      for (const agent of detailsById.get(run.id)?.agents ?? []) {
        refs.push({ agent, run })
      }
    }
    if (scheduler?.run) {
      for (const agent of scheduler.agents ?? []) {
        refs.push({ agent, run: scheduler.run })
      }
    }
    return refs
  }, [runs, detailsById, scheduler])

  const groups = useMemo(() => {
    const map = new Map<string, AgentRef[]>()
    for (const ref of allAgents) {
      const role = ref.agent.role || "agent"
      const list = map.get(role) ?? []
      list.push(ref)
      map.set(role, list)
    }
    return [...map.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )
  }, [allAgents])

  if (allAgents.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>暂无 Agents</EmptyTitle>
          <EmptyDescription>
            启动任务后，agent 将按角色聚合在这里。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-3 p-1">
        {groups.map(([role, refs]) => (
          <section key={role}>
            <div className="flex items-center gap-2 p-1">
              <h3 className="text-sm font-medium">{roleLabel(role)}</h3>
              <Badge size="sm" variant="secondary">
                {refs.length}
              </Badge>
            </div>
            <Card>
              <CardPanel className="p-0">
                <div className="flex flex-col">
                  {refs.map(({ agent, run }) => (
                    <button
                      className="flex min-w-0 items-center gap-2.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-accent"
                      key={agent.id}
                      onClick={() => onSelectAgent(run.id, agent.id)}
                      type="button"
                    >
                      <AgentStatusIcon
                        className="[&_svg]:size-4"
                        status={agent.status}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {agent.name ?? roleLabel(agent.role)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {run.scopeType === "event"
                            ? "调度者"
                            : run.challengeName}
                        </span>
                      </span>
                      {agent.isEntry && (
                        <Badge size="sm" variant="secondary">
                          入口
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              </CardPanel>
            </Card>
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}

// --- Agents Graph ----------------------------------------------------------

function AgentsGraph({
  runs,
  detailsById,
  scheduler,
  onSelectAgent,
}: {
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  onSelectAgent: (runId: string, agentId: string) => void
}) {
  const [schedulerOpen, setSchedulerOpen] = useState(true)
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => {
    // Default-expand active runs.
    return new Set(
      runs.filter((run) => run.status !== "closed").map((run) => run.id)
    )
  })
  const schedRun = scheduler?.run ?? null

  const toggleRun = (runId: string) => {
    setOpenRuns((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  const sortedRuns = [...runs].sort((left, right) => {
    const activeRank = (run: RunPublic) => (run.status === "closed" ? 1 : 0)
    return (
      activeRank(left) - activeRank(right) ||
      right.updatedAt.localeCompare(left.updatedAt)
    )
  })

  return (
    <CardFrame className="flex h-full min-h-0 flex-col">
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex items-center gap-2">
            <Network className="size-4" /> Agents Graph
          </span>
        </CardFrameTitle>
        <CardFrameDescription>调度者 → 任务 → agents</CardFrameDescription>
      </CardFrameHeader>
      <Card className="min-h-0 flex-1">
        <CardPanel className="min-h-0 flex-1 overflow-hidden p-0">
          <ScrollArea className="h-full" scrollFade scrollbarGutter>
            <div className="flex flex-col p-3">
              <GraphNode
                active={schedulerOpen}
                icon={<BrainCircuit className="size-4" />}
                onClick={() => setSchedulerOpen((open) => !open)}
                title="调度者"
                trailing={
                  <Badge size="sm" variant="secondary">
                    {scheduler?.run
                      ? runStatusLabel(scheduler.run.status)
                      : "未启用"}
                  </Badge>
                }
              />
              {schedulerOpen && (
                <div className="ml-[1.125rem] flex flex-col border-l border-border pl-3">
                  {schedRun ? (
                    <>
                      <GraphNode
                        active
                        icon={<Bot className="size-4" />}
                        onClick={() => toggleRun(schedRun.id)}
                        title="调度者任务"
                        trailing={
                          <Badge
                            size="sm"
                            variant={statusVariant(schedRun.status)}
                          >
                            {runStatusLabel(schedRun.status)}
                          </Badge>
                        }
                      />
                      <div className="ml-[1.125rem] flex flex-col border-l border-border pl-3">
                        {(scheduler?.agents ?? []).map((agent) => (
                          <AgentNode
                            agent={agent}
                            key={agent.id}
                            onSelect={() =>
                              onSelectAgent(schedRun.id, agent.id)
                            }
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="py-2 text-xs text-muted-foreground">
                      未启动。在概览页启动调度者后显示。
                    </p>
                  )}
                </div>
              )}
              {sortedRuns.map((run) => {
                const agents = detailsById.get(run.id)?.agents ?? []
                const open = openRuns.has(run.id)
                return (
                  <div key={run.id}>
                    <GraphNode
                      active={open}
                      icon={
                        <span className="flex size-4 items-center justify-center">
                          <Server className="size-3.5" />
                        </span>
                      }
                      onClick={() => toggleRun(run.id)}
                      title={run.challengeName}
                      trailing={
                        <Badge size="sm" variant={statusVariant(run.status)}>
                          {runStatusLabel(run.status)}
                        </Badge>
                      }
                    />
                    {open && (
                      <div className="ml-[1.125rem] flex flex-col border-l border-border pl-3">
                        {agents.length === 0 ? (
                          <p className="py-1.5 text-xs text-muted-foreground">
                            无 agents
                          </p>
                        ) : (
                          agents.map((agent) => (
                            <AgentNode
                              agent={agent}
                              key={agent.id}
                              onSelect={() => onSelectAgent(run.id, agent.id)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

function GraphNode({
  icon,
  title,
  trailing,
  active,
  onClick,
}: {
  icon: ReactNode
  title: string
  trailing?: ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      onClick={onClick}
      type="button"
    >
      <ChevronDown
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !active && "-rotate-90"
        )}
      />
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      {trailing}
    </button>
  )
}

function AgentNode({
  agent,
  onSelect,
}: {
  agent: AgentSummary
  onSelect: () => void
}) {
  return (
    <button
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      onClick={onSelect}
      type="button"
    >
      <AgentStatusIcon className="[&_svg]:size-3.5" status={agent.status} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {agent.name ?? roleLabel(agent.role)}
      </span>
      {agent.parentAgentId && (
        <GitFork
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
    </button>
  )
}

// --- Agent 大弹窗 -----------------------------------------------------------

function AgentDialog({
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
  })
  const [view, setView] = useState<"conversation" | "files" | "overview">(
    "conversation"
  )

  const run = detail.data?.run
  const agents = detail.data?.agents ?? []
  const agent = agents.find((item) => item.id === agentId)
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

  const sendMessage = useCallback(
    (id: string, text: string, deliverAs?: "steer" | "followUp") =>
      agentsApi.sendMessage(id, { text, deliverAs }),
    []
  )
  const switchModel = useCallback(
    (id: string, input: { modelId: string; thinkingLevel: ThinkingLevel }) =>
      agentsApi.switchModel(id, input).then(() =>
        queryClient.invalidateQueries({
          queryKey: keys.runs.fleet(run.eventId),
        })
      ),
    [run.eventId, queryClient]
  )
  const loadMessages = useCallback(
    () => runsApi.listMessages(runId, 0, agentId).then((list) => list.items),
    [runId, agentId]
  )
  const findCurrentModelId = useCallback(
    (models: AvailableModel[]) =>
      models.find(
        (model) =>
          model.modelId === run.modelId && model.providerLabel === run.provider
      )?.id,
    [run.modelId, run.provider]
  )

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
        <DialogPanel className="flex min-h-0 flex-1 flex-col p-0">
          <Tabs
            className="flex h-full min-h-0 min-w-0 flex-col"
            onValueChange={(value) =>
              setView(value as "conversation" | "files" | "overview")
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
            </TabsList>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="conversation"
            >
              <Conversation
                agents={[agent]}
                canEditQueue={false}
                channel={runId}
                closedReopenable={run.scopeType === "challenge"}
                findCurrentModelId={findCurrentModelId}
                key={`${runId}:${agentId}`}
                loadMessages={loadMessages}
                sendMessage={sendMessage}
                status={run.status}
                streamPath={`/api/runs/${runId}/stream`}
                switchModel={switchModel}
                thinkingLevel={run.thinkingLevel}
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
          </Tabs>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
