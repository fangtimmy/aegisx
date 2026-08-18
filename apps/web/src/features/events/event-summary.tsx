import { useQuery } from "@tanstack/react-query"
import { BrainCircuit, ListOrdered, Network, Play } from "lucide-react"
import { type ReactNode } from "react"

import {
  agentsApi,
  type AgentSummary,
  type AgentUsage,
  type Challenge,
  eventsApi,
  keys,
  type QueueItem,
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
import {
  agentStatusLabel,
  formatCost,
  formatTokens,
} from "@/features/runs/agent-overview"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"

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

/** Scheduler endpoint payload (the scheduler agent is `agent`). */
type SchedulerData = SchedulerInfo

/** Event-wide overview: challenge progress, fleet stats, token usage. */
export function EventSummary({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
  // Fleet: challenges + per-challenge agents + the scheduler agent +
  // config/status (the overview's single source of truth, one endpoint).
  // Always polls — the scheduler acts server-side at any time.
  const fleet = useQuery({
    queryKey: keys.agents.fleet(eventId),
    queryFn: () => agentsApi.getFleet(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })
  // Scheduler endpoint (config + the scheduler agent + status).
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: async (): Promise<SchedulerData> =>
      schedulerApi.getScheduler(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })
  // The queue snapshot.
  const queue = useQuery({
    queryKey: keys.scheduler.queue(eventId),
    queryFn: () => schedulerApi.listQueue(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })
  // Event-wide token usage + cost.
  const usage = useQuery({
    queryKey: keys.events.usage(eventId),
    queryFn: () => eventsApi.getEventUsage(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })

  const agentsByChallenge = fleet.data?.agentsByChallenge ?? {}
  const schedulerAgent =
    fleet.data?.schedulerAgent ?? scheduler.data?.agent ?? null

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

  return (
    <SummaryTab
      challenges={challenges}
      agentsByChallenge={agentsByChallenge}
      schedulerAgent={schedulerAgent}
      queue={queue.data?.items ?? []}
      usage={usage.data?.usage}
    />
  )
}

function SummaryTab({
  challenges,
  agentsByChallenge,
  schedulerAgent,
  queue,
  usage,
}: {
  challenges: Challenge[]
  agentsByChallenge: Record<string, AgentSummary[]>
  schedulerAgent: AgentSummary | null
  queue: QueueItem[]
  usage?: AgentUsage
}) {
  const solved = challenges.filter(isChallengeSolved).length
  const total = challenges.length
  const solvedPercent = total > 0 ? Math.round((solved / total) * 100) : 0
  const pendingQueue = queue.filter((item) => item.status === "pending")

  // Flatten the per-challenge agents into one active list (history included;
  // the solver agents that ever attacked each challenge). Include the
  // scheduler agent when live.
  const activeAgents: AgentSummary[] = []
  for (const list of Object.values(agentsByChallenge)) {
    for (const agent of list) {
      if (agent.status === "running" || agent.status === "idle")
        activeAgents.push(agent)
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
            value={String(activeAgents.length)}
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
              schedulerAgent
                ? agentStatusLabel(schedulerAgent.status)
                : "未启用"
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
                {activeAgents.map((agent) => (
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
                        {agent.challengeName || "调度者"}
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
