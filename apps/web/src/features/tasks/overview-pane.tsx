import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, ListOrdered, Plus, Square } from "lucide-react"
import { useMemo, useState } from "react"

import {
  agentsApi,
  keys,
  schedulerApi,
  type AgentSummary,
  type Challenge,
  type FleetInfo,
} from "@/api"
import { ListRow } from "@/components/list-row"
import { Markdown } from "@/components/markdown"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FlagHistory } from "@/features/events/challenge-flags"
import { POLL_INTERVAL_MS } from "@/features/events/event-agents-shared"
import { overallSolved } from "@/features/events/event-shared"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { SpawnAgentDialog } from "@/features/runs/spawn-agent-dialog"
import { TargetPanel } from "@/features/runs/target-panel"
import { formatTime } from "@/lib/format"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import { SchedulerControlPanel } from "./scheduler-control-panel"
import { formatRemaining, shortModel } from "./task-list"

/** Overview tab: the challenge variant (header/flags/target/roster/actions)
 * or the scheduler variant (control panel + inbox; the plan queue lives in
 * its own tab and the policy in the event settings). */
export function OverviewPane({
  eventId,
  challenge,
  lite,
  agents,
  pendingCount,
  schedulerAgent,
  config,
  onSelectAgent,
}: {
  eventId: string
  challenge?: Challenge
  lite?: FleetInfo["challenges"][number]
  /** The challenge's agents (empty for the scheduler variant). */
  agents: AgentSummary[]
  /** The challenge's pending queue items (halt-button gating + copy). */
  pendingCount: number
  schedulerAgent: AgentSummary | null
  config: FleetInfo["config"]
  onSelectAgent: (agentId: string) => void
}) {
  if (!challenge && !lite) {
    return (
      <SchedulerOverview
        config={config}
        eventId={eventId}
        schedulerAgent={schedulerAgent}
      />
    )
  }
  return (
    <ChallengeOverview
      agents={agents}
      challenge={challenge}
      eventId={eventId}
      lite={lite!}
      pendingCount={pendingCount}
      onSelectAgent={onSelectAgent}
    />
  )
}

function ChallengeOverview({
  eventId,
  challenge,
  lite,
  agents,
  pendingCount,
  onSelectAgent,
}: {
  eventId: string
  challenge?: Challenge
  lite: FleetInfo["challenges"][number]
  agents: AgentSummary[]
  pendingCount: number
  onSelectAgent: (agentId: string) => void
}) {
  const queryClient = useQueryClient()
  const liveCount = agents.filter(
    (agent) => agent.status === "running" || agent.status === "idle"
  ).length

  const enqueue = useMutation({
    mutationFn: () => agentsApi.enqueueSpawn(eventId, { challengeId: lite.id }),
    onSuccess: () => {
      toast.success("已加入队列")
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.agents.fleet(eventId),
      })
    },
    onError: (error) => toast.error("入队失败", error.message),
  })

  const spawnTarget = challenge ?? lite
  const progress = challenge?.progress
  const solved = challenge ? overallSolved(challenge) : "unsolved"

  return (
    <ScrollArea className="h-full" scrollFade>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">
            {lite.category && (
              <span className="text-sm font-normal text-muted-foreground">
                {lite.category}/
              </span>
            )}
            {lite.name}
          </h2>
          <Badge variant="secondary">
            {challenge?.points == null ? "无分值" : `${challenge.points} 分`}
          </Badge>
          {solved === "solved" ? (
            <Badge variant="success">已解决</Badge>
          ) : progress && progress.confirmed > 0 ? (
            <Badge variant="outline">
              flag {progress.confirmed}/{progress.required}
            </Badge>
          ) : null}
          <span className="ml-auto flex gap-2">
            <SpawnAgentDialog
              challenge={spawnTarget}
              eventId={eventId}
              trigger={
                <>
                  <Plus /> 新尝试
                </>
              }
              triggerSize="sm"
              triggerVariant="outline"
            />
            <Button
              loading={enqueue.isPending}
              onClick={() => enqueue.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              <ListOrdered /> 入队
            </Button>
            {(liveCount > 0 || pendingCount > 0) && (
              <HaltChallengeButton
                challengeId={lite.id}
                eventId={eventId}
                liveCount={liveCount}
                name={lite.name}
                pendingCount={pendingCount}
              />
            )}
          </span>
        </div>

        {challenge?.description ? (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3.5 shrink-0 transition-transform data-panel-open:rotate-90" />
              题目描述
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="rounded-lg bg-muted/40 p-3 text-sm">
                <Markdown>{challenge.description}</Markdown>
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}

        <p className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {liveCount} 活跃 · {agents.length} 次尝试
          </span>
          {challenge && challenge.attachments.length > 0 && (
            <span className="tabular-nums">
              附件 {challenge.attachments.length}
            </span>
          )}
        </p>

        <TargetPanel challengeId={lite.id} />

        {challenge && challenge.flags.length > 0 && (
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>
                <span className="flex items-center gap-2">
                  Flag 记录
                  <Badge size="sm" variant="secondary">
                    {challenge.flags.length}
                  </Badge>
                </span>
              </CardFrameTitle>
            </CardFrameHeader>
            <Card>
              <CardPanel>
                <FlagHistory flags={challenge.flags} />
              </CardPanel>
            </Card>
          </CardFrame>
        )}

        <Roster agents={agents} onSelectAgent={onSelectAgent} />
      </div>
    </ScrollArea>
  )
}

/** Header force-stop for one challenge: closes its live agents (terminal
 * aborted, reopenable) + cancels its pending queue items; the server also
 * stops the platform target best-effort. */
function HaltChallengeButton({
  challengeId,
  eventId,
  liveCount,
  pendingCount,
  name,
}: {
  challengeId: string
  eventId: string
  liveCount: number
  pendingCount: number
  name: string
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const halt = useMutation({
    mutationFn: () => agentsApi.haltChallenge(challengeId),
    onSuccess: (result) => {
      toast.success(
        result.closed === 0 && result.cancelled === 0
          ? "本题已无进行中的活动"
          : `已停止：关闭 ${result.closed} 个 agent、取消 ${result.cancelled} 个排队项`
      )
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.agents.fleet(eventId),
      })
    },
    onError: (error) => toast.error("停止失败", error.message),
  })
  return (
    <AlertDialog
      onOpenChange={(open) => !open && setConfirming(false)}
      open={confirming}
    >
      <Button
        onClick={() => setConfirming(true)}
        size="sm"
        type="button"
        variant="destructive-outline"
      >
        <Square /> 停止
      </Button>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>停止「{name}」的全部活动？</AlertDialogTitle>
          <AlertDialogDescription>
            将关闭 {liveCount} 个 live agent（终态
            aborted，文件与会话保留，可随时唤醒）
            {pendingCount > 0 ? `，取消 ${pendingCount} 个排队项` : ""}
            ，并停止平台 target。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="ghost" />}>
            取消
          </AlertDialogClose>
          <Button
            loading={halt.isPending}
            onClick={() => {
              halt.mutate()
              setConfirming(false)
            }}
            type="button"
            variant="destructive"
          >
            停止
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

/** The challenge's agent roster in attempt order; a row click jumps to the
 * conversation tab with that agent selected. */
function Roster({
  agents,
  onSelectAgent,
}: {
  agents: AgentSummary[]
  onSelectAgent: (agentId: string) => void
}) {
  const ordered = useMemo(
    () =>
      [...agents].toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      ),
    [agents]
  )
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex items-center gap-2">
            Agent 花名册
            <Badge size="sm" variant="secondary">
              {ordered.length}
            </Badge>
          </span>
        </CardFrameTitle>
      </CardFrameHeader>
      {ordered.length === 0 ? (
        <Card>
          <CardPanel className="text-sm text-muted-foreground">
            本题尚无尝试。在「对话」标签页发起第一次尝试。
          </CardPanel>
        </Card>
      ) : (
        <Card>
          <CardPanel className="p-0">
            <div className="divide-y">
              {ordered.map((agent, index) => (
                <RosterRow
                  agent={agent}
                  index={index}
                  key={agent.id}
                  onSelect={onSelectAgent}
                />
              ))}
            </div>
          </CardPanel>
        </Card>
      )}
    </CardFrame>
  )
}

function RosterRow({
  agent,
  index,
  onSelect,
}: {
  agent: AgentSummary
  index: number
  onSelect: (agentId: string) => void
}) {
  const terminal = agent.status !== "running" && agent.status !== "idle"
  const deadline =
    !terminal && agent.deadlineAt
      ? formatRemaining(agent.deadlineAt, Date.now())
      : null
  return (
    <ListRow
      className={cn("gap-3 rounded-none px-3 py-2", terminal && "opacity-60")}
      onClick={() => onSelect(agent.id)}
    >
      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
        #{index + 1}
      </span>
      <AgentStatusIcon status={agent.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium">
            {agent.name ?? `agent-${agent.id.slice(0, 8)}`}
          </span>
          <code className="shrink-0 font-mono text-2xs text-muted-foreground">
            {shortModel(agent.model)}
          </code>
        </div>
        {(agent.summary ?? agent.error) && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {agent.summary ?? agent.error}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right text-2xs text-muted-foreground">
        <div>创建 {formatTime(agent.createdAt)}</div>
        {deadline ? (
          <div className={cn("tabular-nums", deadline.className)}>
            {deadline.text}
          </div>
        ) : terminal ? (
          <div>
            结束 {agent.completedAt ? formatTime(agent.completedAt) : "—"}
          </div>
        ) : null}
      </div>
    </ListRow>
  )
}

function SchedulerOverview({
  eventId,
  schedulerAgent,
  config,
}: {
  eventId: string
  schedulerAgent: AgentSummary | null
  config: FleetInfo["config"]
}) {
  const inbox = useQuery({
    queryKey: keys.scheduler.inbox(eventId),
    queryFn: () => schedulerApi.getInbox(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })

  return (
    <ScrollArea className="h-full" scrollFade>
      <div className="flex flex-col gap-4 p-4">
        <SchedulerControlPanel
          agent={schedulerAgent}
          config={config}
          eventId={eventId}
        />

        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>调度收件箱</CardFrameTitle>
            <CardFrameAction className="flex items-center gap-2">
              {inbox.error ? (
                <Badge size="sm" variant="secondary">
                  收件箱加载失败
                </Badge>
              ) : inbox.data ? (
                <>
                  {inbox.data.unreadCount > 0 ? (
                    <Badge size="sm" variant="info">
                      未读 {inbox.data.unreadCount}
                    </Badge>
                  ) : (
                    <Badge size="sm" variant="secondary">
                      无未读
                    </Badge>
                  )}
                  {inbox.data.deliveryPaused && (
                    <Badge size="sm" variant="warning">
                      投递已暂停
                    </Badge>
                  )}
                </>
              ) : (
                <Badge size="sm" variant="secondary">
                  加载中…
                </Badge>
              )}
            </CardFrameAction>
          </CardFrameHeader>
          <Card>
            <CardPanel className="text-xs text-muted-foreground">
              求解者的提问与调度事件汇总在「频道」标签页。
            </CardPanel>
          </Card>
        </CardFrame>
      </div>
    </ScrollArea>
  )
}
