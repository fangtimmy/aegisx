import { useMemo } from "react"

import type { Challenge, AgentSummary } from "@/api"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

import { TIMELINE_ICONS, type TimelineEvent } from "./event-agents-shared"

function buildTimeline(
  challenges: Challenge[],
  agents: AgentSummary[]
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
        agentId: flag.agentId ?? undefined,
      })
    }
  }
  for (const agent of agents) {
    events.push({
      time: agent.createdAt,
      id: `agent:${agent.id}:created`,
      kind: "agent",
      title: "Agent 启动",
      detail: `${agent.challengeName} · ${
        agent.source === "scheduler" ? "调度者" : "手动"
      }`,
      agentId: agent.id,
    })
    if (agent.lastTimeoutAt) {
      // Outcome is not persisted — infer from the agent's current state
      // (a timeout with a still-warm agent settled to idle; an aborted one
      // was SIGKILLed).
      events.push({
        time: agent.lastTimeoutAt,
        id: `agent:${agent.id}:timeout`,
        kind: "timeout",
        title: "Agent 超时",
        detail: `${agent.challengeName} · ${
          agent.status === "aborted" ? "超时未恢复，已强制关闭" : "已恢复"
        }`,
        agentId: agent.id,
      })
    }
    if (agent.completedAt) {
      events.push({
        time: agent.completedAt,
        id: `agent:${agent.id}:completed`,
        kind: "completed",
        title: "Agent 结束",
        detail: `${agent.challengeName}${
          agent.summary ? ` · ${agent.summary.slice(0, 48)}` : ""
        }`,
        agentId: agent.id,
      })
    }
  }
  return events.sort((left, right) => right.time.localeCompare(left.time))
}

export function TimelineTab({
  challenges,
  agents,
  onSelectAgent,
}: {
  challenges: Challenge[]
  agents: AgentSummary[]
  /** W7: click an agent-linked entry → highlight the agent on the graph (no
   * dialog). */
  onSelectAgent?: (agentId: string) => void
}) {
  const events = useMemo(
    () => buildTimeline(challenges, agents),
    [challenges, agents]
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
                  event.kind === "completed" &&
                    "border-border bg-muted text-muted-foreground",
                  event.kind === "agent" &&
                    "border-info/30 bg-info/10 text-info",
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
          return event.agentId ? (
            <li className="border-b py-2.5 last:border-b-0" key={event.id}>
              <button
                className="block w-full cursor-pointer rounded-md text-left hover:bg-accent"
                disabled={!onSelectAgent}
                onClick={() => onSelectAgent?.(event.agentId!)}
                type="button"
              >
                {row}
              </button>
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
