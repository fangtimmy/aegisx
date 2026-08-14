import { useQuery } from "@tanstack/react-query"
import { BrainCircuit, ListOrdered, Network, Play } from "lucide-react"
import { type ReactNode, useMemo } from "react"

import {
  type AgentSummary,
  type Challenge,
  eventsApi,
  keys,
  type QueueItem,
  type RunPublic,
  type RunUsage,
  runsApi,
  schedulerApi,
  type SchedulerInfo,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import {
  formatCost,
  formatTokens,
  runStatusLabel,
} from "@/features/runs/run-overview"

import { ErrorState, isChallengeSolved } from "./event-shared"

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

/** Scheduler endpoint payload + its run's agents (fetched in one query). */
type SchedulerWithAgents = SchedulerInfo & { agents: AgentSummary[] }

/** An agent + the run it belongs to (for cross-run aggregation). */
type AgentRef = { agent: AgentSummary; run: RunPublic }

/** Event-wide overview: challenge progress, fleet stats, token usage. */
export function EventSummary({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
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
  // Scheduler (event-scoped run) + its agents.
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: async (): Promise<SchedulerWithAgents> => {
      const data = await schedulerApi.getScheduler(eventId)
      const agents = data.run ? (await runsApi.getRun(data.run.id)).agents : []
      return { ...data, agents }
    },
    refetchInterval: POLL_INTERVAL_MS,
  })
  // The queue snapshot.
  const queue = useQuery({
    queryKey: keys.scheduler.queue(eventId),
    queryFn: () => schedulerApi.listQueue(eventId),
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
    <SummaryTab
      challenges={challenges}
      detailsById={detailsById}
      queue={queue.data?.items ?? []}
      runs={runs}
      scheduler={schedulerData}
      usage={usage.data?.usage}
    />
  )
}

function SummaryTab({
  challenges,
  runs,
  detailsById,
  scheduler,
  queue,
  usage,
}: {
  challenges: Challenge[]
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  queue: QueueItem[]
  usage?: RunUsage
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
                  <div
                    className="flex min-w-0 items-center gap-2.5 border-b px-4 py-2.5 last:border-b-0"
                    key={agent.id}
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
                  </div>
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
