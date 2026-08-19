import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import {
  agentsApi,
  keys,
  type AgentDetail,
  type AgentSummary,
  type Challenge,
  type ModelRef,
} from "@/api"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { POLL_INTERVAL_MS } from "@/features/events/event-agents-shared"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { Conversation } from "@/features/runs/conversation"
import { SpawnAgentDialog } from "@/features/runs/spawn-agent-dialog"
import { cn } from "@/lib/utils"

import { formatAgo, shortModel } from "./task-list"

function isLive(agent: AgentSummary) {
  return agent.status === "running" || agent.status === "idle"
}

/** Conversation tab: an agent list (left, challenge variant only) + the
 * reused single-agent Conversation (right). The scheduler variant renders
 * the Conversation alone — there is exactly one orchestrator. */
export function ConversationPane({
  eventId,
  challenge,
  agents,
  schedulerAgent,
  agentId,
  onSelectAgent,
  onClearAgent,
}: {
  eventId: string
  /** The selected challenge (undefined = the scheduler variant). */
  challenge?: Pick<Challenge, "id" | "name">
  agents: AgentSummary[]
  schedulerAgent: AgentSummary | null
  /** ?a= — an explicit selection; null/invalid falls back to derivation. */
  agentId: string | null
  onSelectAgent: (agentId: string) => void
  onClearAgent: () => void
}) {
  const isScheduler = !challenge
  const queryClient = useQueryClient()
  const [onlyActive, setOnlyActive] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const ordered = useMemo(
    () =>
      [...agents].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      ),
    [agents]
  )

  const explicit =
    agentId && ordered.some((agent) => agent.id === agentId) ? agentId : null
  const derived = deriveDefault(ordered)
  const currentId = isScheduler
    ? (schedulerAgent?.id ?? null)
    : (explicit ?? derived)

  const visible = onlyActive ? ordered.filter(isLive) : ordered

  // Spawn success: refetch first so the derivation below sees the new
  // agent, then drop ?a= so "latest live" (the fresh spawn) wins.
  const handleSpawned = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: keys.agents.fleet(eventId),
    })
    onClearAgent()
  }, [queryClient, eventId, onClearAgent])

  return (
    <div
      className={cn(
        "grid h-full min-h-0",
        isScheduler ? "grid-cols-1" : "grid-cols-[12.5rem_minmax(0,1fr)]"
      )}
    >
      {!isScheduler && (
        <aside className="flex min-h-0 flex-col border-r">
          <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
            <button
              aria-pressed={onlyActive}
              className={cn(
                "rounded-sm border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-accent",
                onlyActive && "border-transparent bg-secondary font-medium"
              )}
              onClick={() => setOnlyActive((value) => !value)}
              type="button"
            >
              仅活跃
            </button>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {visible.length}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1" scrollFade>
            <div className="flex flex-col pr-1">
              {visible.map((agent) => (
                <AgentListRow
                  agent={agent}
                  index={ordered.indexOf(agent)}
                  isSelected={agent.id === currentId}
                  key={agent.id}
                  nowMs={nowMs}
                  onSelect={onSelectAgent}
                />
              ))}
              {visible.length === 0 && (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  {onlyActive ? "无活跃 agent。" : "尚无尝试。"}
                </p>
              )}
            </div>
          </ScrollArea>
          <div className="shrink-0 border-t p-2">
            <SpawnAgentDialog
              challenge={challenge}
              onSpawned={handleSpawned}
              trigger={
                <>
                  <Plus /> 新尝试
                </>
              }
              triggerClassName="w-full justify-start"
              triggerSize="sm"
              triggerVariant="ghost"
            />
          </div>
        </aside>
      )}
      <div className="min-h-0 min-w-0">
        {currentId ? (
          <AgentConversation agentId={currentId} eventId={eventId} />
        ) : isScheduler ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>调度者未启动</EmptyTitle>
              <EmptyDescription>
                在「概览」标签页启动调度者后，可在此与其对话。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty className="h-full py-16">
            <EmptyHeader>
              <EmptyTitle>本题尚无尝试</EmptyTitle>
              <EmptyDescription>
                发起第一次尝试，或在「概览」中入队等待调度。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <SpawnAgentDialog
                challenge={challenge}
                onSpawned={handleSpawned}
                trigger={
                  <>
                    <Plus /> 新尝试
                  </>
                }
                triggerVariant="outline"
              />
            </EmptyContent>
          </Empty>
        )}
      </div>
    </div>
  )
}

/** Default conversation target: the latest live agent, else the latest
 * terminal one (history stays readable), else none. */
function deriveDefault(agents: AgentSummary[]): string | null {
  const live = agents.filter(isLive)
  const pool = live.length > 0 ? live : agents
  let latest: AgentSummary | null = null
  for (const agent of pool) {
    if (!latest || agent.createdAt > latest.createdAt) latest = agent
  }
  return latest?.id ?? null
}

/** One attempt row: status + short id + model + last-activity age. */
function AgentListRow({
  agent,
  index,
  isSelected,
  nowMs,
  onSelect,
}: {
  agent: AgentSummary
  index: number
  isSelected: boolean
  nowMs: number
  onSelect: (agentId: string) => void
}) {
  const terminal = !isLive(agent)
  return (
    <button
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
        isSelected && "bg-accent",
        terminal && "opacity-55"
      )}
      onClick={() => onSelect(agent.id)}
      type="button"
    >
      <AgentStatusIcon className="mt-0.5" status={agent.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          #{index + 1} {shortModel(agent.model)}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {formatAgo(agent.updatedAt, nowMs)}
        </span>
      </span>
    </button>
  )
}

/** Single-agent Conversation host. The adapter wiring mirrors AgentDialog:
 * detail poll while running, SSE per agent, fleet invalidation on ops. */
function AgentConversation({
  agentId,
  eventId,
}: {
  agentId: string
  eventId: string
}) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: keys.agents.detail(agentId),
    queryFn: () => agentsApi.getAgent(agentId),
    // Poll while running so the composer's send→stop swap and the status
    // stay live (the fleet query doesn't feed this cache key).
    refetchInterval: (query) =>
      query.state.data && query.state.data.agent.status === "running"
        ? POLL_INTERVAL_MS
        : false,
  })

  const agent = detail.data?.agent

  const sendMessage = useCallback(
    (text: string, deliverAs?: "steer" | "followUp") =>
      agentsApi.sendMessage(agentId, { text, deliverAs }),
    [agentId]
  )
  const switchModel = useCallback(
    (ref: ModelRef) =>
      agentsApi.switchModel(agentId, { model: ref }).then(() =>
        queryClient.invalidateQueries({
          queryKey: keys.agents.fleet(eventId),
        })
      ),
    [eventId, queryClient, agentId]
  )
  const loadMessages = useCallback(
    () => agentsApi.listMessages(agentId).then((list) => list.items),
    [agentId]
  )
  const setQueue = useCallback(
    (id: string, body: { steering: string[]; followUp: string[] }) =>
      agentsApi.setAgentQueue(id, body),
    []
  )
  const invalidateAgent = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.agents.detail(agentId),
        }),
        queryClient.invalidateQueries({
          queryKey: keys.agents.fleet(eventId),
        }),
      ]),
    [queryClient, agentId, eventId]
  )
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
  // SSE agent.updated → detail cache: the composer's send/stop swap and the
  // status strip follow the stream instantly instead of the next poll.
  const onAgentUpdated = useCallback(
    (next: AgentSummary) => {
      queryClient.setQueryData<AgentDetail>(
        keys.agents.detail(agentId),
        (prev) => (prev ? { ...prev, agent: next } : prev)
      )
    },
    [queryClient, agentId]
  )
  const closeAgent = useCallback(
    () => agentsApi.closeAgent(agentId).then(() => invalidateAgent()),
    [invalidateAgent, agentId]
  )
  const compactAgent = useCallback(
    () => agentsApi.compactAgent(agentId).then(() => invalidateAgent()),
    [invalidateAgent, agentId]
  )

  if (detail.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载对话…
      </div>
    )
  }
  if (detail.error || !agent) {
    return (
      <Empty className="h-full py-16">
        <EmptyHeader>
          <EmptyTitle>Agent 不存在</EmptyTitle>
          <EmptyDescription>
            该 agent 可能已被删除，或数据未到达。请刷新后重试。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Conversation
      agent={agent}
      canEditQueue
      closedReopenable
      closeAgent={closeAgent}
      compactAgent={compactAgent}
      detail={detail.data ?? undefined}
      loadMessages={loadMessages}
      onAgentUpdated={onAgentUpdated}
      sendMessage={sendMessage}
      sessionOps={sessionOps}
      setQueue={setQueue}
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
  )
}
