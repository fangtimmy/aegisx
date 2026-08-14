import { aliasRef } from "@aegisx/shared"
import dagre from "@dagrejs/dagre"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react"

import "@xyflow/react/dist/style.css"
import {
  Archive,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  ClipboardList,
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
  Shrink,
  SlidersHorizontal,
  Square,
  Timer,
  Users,
} from "lucide-react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { Link, useNavigate } from "react-router"

import {
  type AgentSummary,
  agentsApi,
  type Challenge,
  eventsApi,
  keys,
  type ModelRef,
  type QueueItem,
  type RunPublic,
  type RunUsage,
  runsApi,
  schedulerApi,
  type SchedulerInfo,
  type ThinkingLevel,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { CreateRunDialog } from "@/features/runs"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { Conversation } from "@/features/runs/conversation"
import { FilesWorkspace } from "@/features/runs/files-workspace"
import {
  type AvailableModel,
  useAvailableModels,
  useResolvedAliases,
} from "@/features/runs/model-switcher"
import {
  formatCost,
  formatTokens,
  RunOverview,
  runStatusLabel,
  statusVariant,
} from "@/features/runs/run-overview"
import { formatTime } from "@/lib/format"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import { ErrorState, isChallengeSolved } from "./event-shared"
import { QueueList } from "./queue-list"

const UNCATEGORIZED = "未分类"

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
}

/** Overview poll cadence (ms). Unconditional — the scheduler acts server-side,
   so the fleet/queue/usage must refresh regardless of locally-known state. */
const POLL_INTERVAL_MS = 5000

const ROLE_LABELS: Record<string, string> = {
  solver: "求解者",
  observer: "观察者",
  orchestrator: "调度者",
  child: "子代理",
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

type OverviewTab =
  | "summary"
  | "plan"
  | "timeline"
  | "challenges"
  | "runs"
  | "agents"

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
  // Event-wide token usage + cost (spec §10).
  const usage = useQuery({
    queryKey: keys.events.usage(eventId),
    queryFn: () => eventsApi.getEventUsage(eventId),
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
        正在加载概览…
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
            <TabsTab className="gap-1.5" value="summary">
              <LayoutPanelTop /> 总览
            </TabsTab>
            <TabsTab className="gap-1.5" value="plan">
              <ClipboardList /> 计划
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
                usage={usage.data?.usage}
              />
            </TabsPanel>
            <TabsPanel className="h-full" value="plan">
              <PlanTab eventId={eventId} queue={queue.data?.items ?? []} />
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

// --- 总览 -----------------------------------------------------------------

function SummaryTab({
  challenges,
  runs,
  detailsById,
  scheduler,
  queue,
  usage,
  onSelectAgent,
}: {
  challenges: Challenge[]
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  queue: QueueItem[]
  usage?: RunUsage
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
        <Card>
          <CardHeader>
            <CardTitle>解题进度</CardTitle>
            <CardDescription>
              {solved} / {total} 已解决
            </CardDescription>
          </CardHeader>
          <CardPanel className="pt-0">
            <Progress value={solvedPercent}>
              <ProgressTrack className="h-2 bg-secondary">
                <ProgressIndicator className="bg-success" />
              </ProgressTrack>
            </Progress>
          </CardPanel>
        </Card>

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

        <Card>
          <CardHeader>
            <CardTitle>用量汇总</CardTitle>
            <CardDescription>
              赛事内全部运行（含调度者）的 token 与费用
            </CardDescription>
          </CardHeader>
          <CardPanel>
            {usage ? (
              <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">总 token</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatTokens(usage.totalTokens)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">费用</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatCost(usage.cost)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">轮次</dt>
                  <dd className="mt-0.5 font-mono text-xs">{usage.turns}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">输入</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatTokens(usage.input)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">输出</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatTokens(usage.output)}
                    {usage.reasoning > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        （{formatTokens(usage.reasoning)} 推理）
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">缓存</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatTokens(usage.cacheRead)} 读 /{" "}
                    {formatTokens(usage.cacheWrite)} 写
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">暂无用量数据。</p>
            )}
          </CardPanel>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>活跃 Agents</CardTitle>
          </CardHeader>
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
        </Card>
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
    <Card>
      <CardPanel className="gap-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="text-xl font-semibold">{value}</span>
      </CardPanel>
    </Card>
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
    <CreateRunDialog
      challenge={challenge}
      trigger={
        <>
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              solved ? "bg-success" : "bg-muted-foreground/40"
            )}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {challenge.name}
          </span>
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
        </>
      }
      triggerClassName="h-auto w-full min-w-0 justify-start rounded-md px-7 py-2 font-normal"
      triggerVariant="ghost"
    />
  )
}

// --- 计划队列（调度者）---------------------------------------------------

function PlanTab({ eventId, queue }: { eventId: string; queue: QueueItem[] }) {
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
              onChanged={() => undefined}
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

// --- Runs 列表 --------------------------------------------------------------

function RunsTab({ runs }: { runs: RunPublic[] }) {
  const activeRuns = runs
    .filter((run) => run.status !== "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const historyRuns = runs
    .filter((run) => run.status === "closed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-4 p-1">
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
  eventId,
  runs,
  detailsById,
  scheduler,
  onSelectAgent,
}: {
  eventId: string
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  onSelectAgent: (runId: string, agentId: string) => void
}) {
  const queryClient = useQueryClient()
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => {
    // Default-expand active runs.
    return new Set(
      runs.filter((run) => run.status !== "closed").map((run) => run.id)
    )
  })
  const schedRun = scheduler?.run ?? null

  // Scheduler lifecycle: start creates the event-scoped orchestrator run;
  // stop cancels the current turn (container kept); close releases it. The
  // scheduler agent itself is interacted with via the same AgentDialog as
  // any run agent — these are the only run-level controls the graph needs.
  const invalidateScheduler = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.detail(eventId),
      }),
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(eventId),
      }),
      queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) }),
      queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    ])
  const startScheduler = useMutation({
    mutationFn: () => schedulerApi.startScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已启动")
      void invalidateScheduler()
    },
    onError: (error) => toast.error("启动调度者失败", error.message),
  })
  const stopScheduler = useMutation({
    mutationFn: () => schedulerApi.stopScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者正在停止")
      void invalidateScheduler()
    },
    onError: (error) => toast.error("停止调度者失败", error.message),
  })
  const closeScheduler = useMutation({
    mutationFn: () => schedulerApi.closeScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已关闭")
      void invalidateScheduler()
    },
    onError: (error) => toast.error("关闭调度者失败", error.message),
  })

  const sortedRuns = [...runs].sort((left, right) => {
    const activeRank = (run: RunPublic) => (run.status === "closed" ? 1 : 0)
    return (
      activeRank(left) - activeRank(right) ||
      right.updatedAt.localeCompare(left.updatedAt)
    )
  })

  // Build + lay out the graph from the fleet state. Recomputed only when the
  // underlying data or the expand toggles change; status-only poll updates
  // with the same node set reuse the cached layout, so nothing jitters.
  const graph = useMemo(
    () =>
      buildAgentsGraph({
        scheduler,
        schedRun,
        runs: sortedRuns,
        detailsById,
        openRuns,
      }),
    [scheduler, schedRun, sortedRuns, detailsById, openRuns]
  )
  // Remount React Flow (→ re-fit-view) only when the node SET changes
  // (expand/collapse/spawn). Status-only polls keep the same key, so the
  // viewport (pan/zoom) is preserved across them.
  const graphKey = useMemo(
    () => graph.nodes.map((node) => node.id).join("|"),
    [graph]
  )
  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      const data = node.data as GraphNodeData
      if (data.kind === "scheduler") {
        // The scheduler node IS the orchestrator agent — open its conversation.
        if (data.runId && data.agentId) onSelectAgent(data.runId, data.agentId)
      } else if (data.kind === "run") {
        setOpenRuns((prev) => {
          const next = new Set(prev)
          if (next.has(data.run.id)) next.delete(data.run.id)
          else next.add(data.run.id)
          return next
        })
      } else {
        onSelectAgent(data.runId, data.agent.id)
      }
    },
    [onSelectAgent]
  )

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            <Network className="size-4" /> Agents Graph
          </span>
        </CardTitle>
        <CardDescription>调度者 → 任务 → agents</CardDescription>
      </CardHeader>
      <CardPanel className="relative min-h-0 flex-1 overflow-hidden p-0">
        <ReactFlow
          edges={graph.edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          key={graphKey}
          maxZoom={1.75}
          minZoom={0.2}
          nodeTypes={GRAPH_NODE_TYPES}
          nodes={graph.nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={onNodeClick}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={22} size={1} />
          <Controls position="bottom-right" showInteractive={false} />
          {/* Scheduler lifecycle controls overlay: start (re)creates the
                event-scoped orchestrator run; stop cancels the current turn;
                close releases the container. The scheduler agent itself is
                driven from the AgentDialog like any run agent. */}
          <Panel
            className="flex flex-wrap items-center gap-1.5"
            position="top-right"
          >
            {!schedRun || schedRun.status === "closed" ? (
              <Button
                loading={startScheduler.isPending}
                onClick={() => startScheduler.mutate()}
                size="sm"
                type="button"
              >
                <Play /> 启动调度者
              </Button>
            ) : (
              <>
                {schedRun.status === "running" && (
                  <Button
                    loading={stopScheduler.isPending}
                    onClick={() => stopScheduler.mutate()}
                    size="xs"
                    title="取消当前轮次（容器保留）"
                    type="button"
                    variant="destructive-outline"
                  >
                    <Square /> 停止
                  </Button>
                )}
                <Button
                  loading={closeScheduler.isPending}
                  onClick={() => closeScheduler.mutate()}
                  size="xs"
                  title="释放调度者容器与会话"
                  type="button"
                  variant="outline"
                >
                  <Archive /> 关闭
                </Button>
              </>
            )}
          </Panel>
        </ReactFlow>
      </CardPanel>
    </Card>
  )
}

// --- Agents Graph: dagre layout + React Flow nodes -------------------------
//
// The graph is a hierarchy: 调度者 (root) → runs → agents, with spawn children
// branching off their parent agent (parentAgentId). dagre ranks the nodes
// top-to-bottom; React Flow renders them with pan/zoom. Clicking a
// scheduler/run node toggles whether its children are shown; clicking an
// agent node opens the AgentDialog.

const SCHED_NODE_ID = "sched"
const runNodeId = (id: string) => `run:${id}`
const agentNodeId = (id: string) => `agent:${id}`

type GraphNodeData =
  | {
      kind: "scheduler"
      /** The scheduler run + its orchestrator agent, when active. Null when
       * no scheduler run exists (placeholder "未启用" node, not clickable). */
      runId: string | null
      agentId: string | null
      status: string
    }
  | { kind: "run"; run: RunPublic; active: boolean }
  | { kind: "agent"; agent: AgentSummary; runId: string }

// Planned node sizes — used both for the dagre layout spacing and (roughly)
// matched by the Tailwind widths on each node component.
const NODE_DIM = {
  scheduler: { width: 176, height: 56 },
  run: { width: 224, height: 60 },
  agent: { width: 192, height: 48 },
} as const

const EDGE_STYLE = {
  // scheduler → run: the orchestrator oversees the whole fleet, kept faint.
  oversee: {
    stroke: "var(--muted-foreground)",
    strokeOpacity: 0.3,
    strokeWidth: 1.5,
  },
  // run → entry agent / scheduler → orchestrator: emphasized.
  entry: { stroke: "var(--primary)", strokeWidth: 2 },
  // run → non-entry agent.
  agent: { stroke: "var(--border)", strokeWidth: 1.5 },
  // agent → spawn child: dashed.
  spawn: {
    stroke: "var(--muted-foreground)",
    strokeOpacity: 0.5,
    strokeWidth: 1.5,
    strokeDasharray: "5 3",
  },
} as const

const GRAPH_NODE_TYPES = {
  scheduler: SchedulerGraphNode,
  run: RunGraphNode,
  agent: AgentGraphNode,
} satisfies NodeTypes

/** Lay out nodes top-to-bottom with dagre, writing absolute positions back
 * onto each node (React Flow needs explicit positions). */
function layoutWithDagre(
  nodes: Node[],
  edges: Edge[],
  dims: Record<string, { width: number; height: number }>
): Node[] {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({
    rankdir: "LR",
    nodesep: 28,
    ranksep: 64,
    marginx: 24,
    marginy: 24,
  })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) {
    const dim = dims[node.id] ?? { width: 160, height: 48 }
    graph.setNode(node.id, { width: dim.width, height: dim.height })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return nodes.map((node) => {
    const laid = graph.node(node.id)
    const dim = dims[node.id] ?? { width: 160, height: 48 }
    return {
      ...node,
      position: { x: laid.x - dim.width / 2, y: laid.y - dim.height / 2 },
    }
  })
}

/** Build the node/edge set for the whole event fleet, then lay it out. */
function buildAgentsGraph({
  scheduler,
  schedRun,
  runs,
  detailsById,
  openRuns,
}: {
  scheduler?: SchedulerWithAgents
  schedRun: RunPublic | null
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  openRuns: Set<string>
}): { nodes: Node[]; edges: Edge[] } {
  const rawNodes: Node[] = []
  const rawEdges: Edge[] = []
  const dims: Record<string, { width: number; height: number }> = {}
  const addNode = (
    id: string,
    type: "scheduler" | "run" | "agent",
    data: GraphNodeData
  ) => {
    rawNodes.push({ id, type, data, position: { x: 0, y: 0 } })
    dims[id] = NODE_DIM[type]
  }

  // Root: the event scheduler. When a scheduler run exists, this node IS its
  // orchestrator agent (click opens that agent's conversation) and the
  // challenge runs hang off it. When no run exists it is a non-clickable
  // "未启用" placeholder — the start control lives in the graph overlay.
  const orchAgent =
    scheduler?.agents?.find((a) => a.isEntry) ?? scheduler?.agents?.[0] ?? null
  addNode(SCHED_NODE_ID, "scheduler", {
    kind: "scheduler",
    runId: schedRun?.id ?? null,
    agentId: orchAgent?.id ?? null,
    status: schedRun ? runStatusLabel(schedRun.status) : "未启用",
  })

  // Challenge runs hang off the scheduler node when one is active; otherwise
  // they stand alone. Each expanded run exposes its agents.
  for (const run of runs) {
    addNode(runNodeId(run.id), "run", {
      kind: "run",
      run,
      active: openRuns.has(run.id),
    })
    if (schedRun) {
      rawEdges.push({
        id: `e:sched:run:${run.id}`,
        source: SCHED_NODE_ID,
        target: runNodeId(run.id),
        type: "smoothstep",
        style: EDGE_STYLE.oversee,
      })
    }
    if (!openRuns.has(run.id)) continue
    const agents = detailsById.get(run.id)?.agents ?? []
    for (const agent of agents) {
      addNode(agentNodeId(agent.id), "agent", {
        kind: "agent",
        agent,
        runId: run.id,
      })
    }
    for (const agent of agents) {
      if (agent.parentAgentId && dims[agentNodeId(agent.parentAgentId)]) {
        rawEdges.push({
          id: `e:spawn:${agent.id}`,
          source: agentNodeId(agent.parentAgentId),
          target: agentNodeId(agent.id),
          type: "smoothstep",
          style: EDGE_STYLE.spawn,
        })
      } else {
        rawEdges.push({
          id: `e:run:${run.id}:${agent.id}`,
          source: runNodeId(run.id),
          target: agentNodeId(agent.id),
          type: "smoothstep",
          style: agent.isEntry ? EDGE_STYLE.entry : EDGE_STYLE.agent,
        })
      }
    }
  }

  return { nodes: layoutWithDagre(rawNodes, rawEdges, dims), edges: rawEdges }
}

function GraphNodeShell({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-xs/5 transition-colors hover:border-foreground/35",
        className
      )}
    >
      {/* Invisible handles — React Flow anchors edges on them; we hide the
          dots for a cleaner look. Every node carries a target (top) and a
          source (bottom) so edges attach on both sides regardless of role. */}
      <Handle className="opacity-0!" position={Position.Left} type="target" />
      {children}
      <Handle className="opacity-0!" position={Position.Right} type="source" />
    </div>
  )
}

function SchedulerGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "scheduler" }>
  const active = d.agentId !== null
  return (
    <GraphNodeShell className={cn("w-44", !active && "opacity-70")}>
      <BrainCircuit
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground"
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {active ? "调度者" : "调度者（未启用）"}
      </span>
      <Badge size="sm" variant="secondary">
        {d.status}
      </Badge>
    </GraphNodeShell>
  )
}

function RunGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "run" }>
  const { run } = d
  return (
    <GraphNodeShell className="w-56">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Server className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight font-medium">
          {run.challengeName}
        </span>
        <span className="block truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {run.orchestration}
          {run.source === "scheduler" ? " · 调度" : ""}
        </span>
      </span>
      <Badge size="sm" variant={statusVariant(run.status)}>
        {runStatusLabel(run.status)}
      </Badge>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !d.active && "-rotate-90"
        )}
      />
    </GraphNodeShell>
  )
}

function AgentGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "agent" }>
  const { agent } = d
  return (
    <GraphNodeShell className="w-48">
      <AgentStatusIcon className="[&_svg]:size-3.5" status={agent.status} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {agent.name ?? roleLabel(agent.role)}
      </span>
      {agent.isEntry ? (
        <Badge size="sm" variant="secondary">
          入口
        </Badge>
      ) : agent.parentAgentId ? (
        <GitFork
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
    </GraphNodeShell>
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
  const findCurrentModelId = useCallback(
    (models: AvailableModel[]) =>
      models.find(
        (model) =>
          model.modelId === run?.modelId &&
          model.providerLabel === run?.provider
      )?.id,
    [run?.modelId, run?.provider]
  )

  // Agent-level controls (spec §10). Stop aborts the current turn (container
  // kept warm); compact runs a manual context summarization (requires an idle
  // session); close releases a challenge run's container. The scheduler run
  // is closed via its graph overlay instead.
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
  const stop = useMutation({
    mutationFn: () => agentsApi.stopAgent(agentId),
    onSuccess: () => {
      toast.success("已停止当前轮")
      void invalidateAgent()
    },
    onError: (error) => toast.error("停止失败", error.message),
  })
  // Shared compact action for the header button and the composer command
  // panel; toasts live at each call site (mutation / Conversation), so this
  // stays silent and just does API + invalidation.
  const compactRun = useCallback(
    () => agentsApi.compactAgent(agentId).then(() => invalidateAgent()),
    [agentId, invalidateAgent]
  )
  const compact = useMutation({
    mutationFn: compactRun,
    onSuccess: () => {
      toast.success("上下文已压缩")
    },
    onError: (error) => toast.error("压缩失败", error.message),
  })
  const close = useMutation({
    mutationFn: () => runsApi.closeRun(runId),
    onSuccess: () => {
      toast.success("已关闭容器")
      void invalidateAgent()
    },
    onError: (error) => toast.error("关闭失败", error.message),
  })

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
          <div className="flex flex-wrap items-center gap-1.5">
            {run.status === "running" && (
              <Button
                loading={stop.isPending}
                onClick={() => stop.mutate()}
                size="xs"
                title="中止当前轮（容器保留）"
                type="button"
                variant="destructive-outline"
              >
                <Square /> 停止
              </Button>
            )}
            <Button
              disabled={run.status === "running"}
              loading={compact.isPending}
              onClick={() => compact.mutate()}
              size="xs"
              title={
                run.status === "running"
                  ? "运行中无法压缩，请先停止"
                  : "手动压缩上下文"
              }
              type="button"
              variant="outline"
            >
              <Shrink /> 压缩
            </Button>
            {run.scopeType === "challenge" && run.status !== "closed" && (
              <Button
                loading={close.isPending}
                onClick={() => close.mutate()}
                size="xs"
                title="释放容器（之后发消息可冷恢复）"
                type="button"
                variant="outline"
              >
                <Archive /> 关闭容器
              </Button>
            )}
          </div>
        </DialogHeader>
        {/* Plain flex div, NOT DialogPanel: DialogPanel wraps its children in
            a ScrollArea, which would scroll the tab bar and the composer
            along with the content. We need the TabsList pinned at top and
            (for the conversation tab) the composer pinned at bottom, so the
            body owns the flex layout and each panel scrolls itself — same
            pattern as run-workspace's CardPanel. */}
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
                closedReopenable={run.scopeType === "challenge"}
                compactAgent={compactRun}
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

// --- 调度者配置（仅 event-scope run）-----------------------------------------

function SchedulerConfigTab({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: () => schedulerApi.getScheduler(eventId),
  })
  const models = useAvailableModels()
  const resolvedAliases = useResolvedAliases(models)
  const config = scheduler.data?.config

  const [modelId, setModelId] = useState<string | null>(config?.modelId ?? null)
  const [instruction, setInstruction] = useState(config?.instruction ?? "")
  const [maxTargets, setMaxTargets] = useState(
    config?.maxConcurrentTargets ?? 1
  )
  useEffect(() => {
    if (!config) return
    setModelId(config.modelId)
    setInstruction(config.instruction)
    setMaxTargets(config.maxConcurrentTargets)
  }, [config])

  const grouped = useMemo(() => {
    const map = new Map<string, AvailableModel[]>()
    for (const model of models) {
      const bucket = map.get(model.providerLabel) ?? []
      bucket.push(model)
      map.set(model.providerLabel, bucket)
    }
    return [...map.entries()]
  }, [models])

  const save = useMutation({
    mutationFn: () =>
      schedulerApi.updateSchedulerConfig(eventId, {
        modelId,
        instruction,
        maxConcurrentTargets: maxTargets,
      }),
    onSuccess: () => {
      toast.success("调度者配置已保存")
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.detail(eventId),
      })
    },
    onError: (error) => toast.error("保存失败", error.message),
  })

  if (scheduler.isPending || !config) {
    return (
      <div
        className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载配置…
      </div>
    )
  }

  return (
    <ScrollArea className="h-full" scrollFade>
      <form
        className="flex flex-col gap-5 px-6 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="sched-model">默认模型</FieldLabel>
          <FieldDescription>
            调度者下次启动时使用的模型；留空则使用全局默认。
          </FieldDescription>
          <Select
            onValueChange={(value) =>
              setModelId(value && value !== "" ? value : null)
            }
            value={modelId ?? ""}
          >
            <SelectTrigger id="sched-model">
              <SelectValue placeholder="全局默认" />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">全局默认</SelectItem>
              {resolvedAliases.length > 0 && (
                <SelectGroup key="aliases">
                  <SelectGroupLabel>别名</SelectGroupLabel>
                  {resolvedAliases.map(({ alias, target }) => (
                    <SelectItem
                      key={aliasRef(alias.id)}
                      value={aliasRef(alias.id)}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium">{alias.label}</span>
                        <span className="text-muted-foreground">
                          → {target.label}
                        </span>
                        {alias.thinkingLevel !== "off" && (
                          <Badge size="sm" variant="secondary">
                            {thinkingLevelLabels[alias.thinkingLevel]}
                          </Badge>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {grouped.map(([providerLabel, list]) => (
                <SelectGroup key={providerLabel}>
                  <SelectGroupLabel>{providerLabel}</SelectGroupLabel>
                  {list.map((model) => (
                    <SelectItem key={model.id} value={model.address}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="sched-instruction">指令</FieldLabel>
          <FieldDescription>
            追加到调度者系统提示词末尾的常驻指令。
          </FieldDescription>
          <Textarea
            id="sched-instruction"
            onChange={(event) => setInstruction(event.target.value)}
            rows={6}
            value={instruction}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="sched-targets">并发靶机上限</FieldLabel>
          <NumberField
            id="sched-targets"
            min={1}
            onValueChange={(value) => {
              if (typeof value === "number") setMaxTargets(value)
            }}
            value={maxTargets}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement />
              <NumberFieldInput />
              <NumberFieldIncrement />
            </NumberFieldGroup>
          </NumberField>
        </Field>
        <div className="flex justify-end">
          <Button loading={save.isPending} type="submit">
            保存配置
          </Button>
        </div>
      </form>
    </ScrollArea>
  )
}
