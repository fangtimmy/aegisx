import { useMemo, useState } from "react"

import type { AgentSummary } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardPanel } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { cn } from "@/lib/utils"

import {
  agentFinishBadge,
  isAgentFinished,
  roleLabel,
  type SchedulerWithAgents,
} from "./event-agents-shared"

/** An agent + the run it belongs to (for cross-run aggregation). */
type AgentRef = { agent: AgentSummary; run: AgentSummary }

export function AgentsTab({
  agents,
  scheduler,
  onSelectAgent,
}: {
  agents: AgentSummary[]
  scheduler?: SchedulerWithAgents
  onSelectAgent: (agentId: string) => void
}) {
  const [hideFinished, setHideFinished] = useState(false)
  const allAgents: AgentRef[] = useMemo(() => {
    const refs: AgentRef[] = []
    for (const agent of agents) {
      refs.push({ agent, run: agent })
    }
    if (scheduler?.agent) {
      refs.push({ agent: scheduler.agent, run: scheduler.agent })
    }
    return refs
  }, [agents, scheduler])

  const groups = useMemo(() => {
    const map = new Map<string, AgentRef[]>()
    for (const ref of allAgents) {
      if (hideFinished && isAgentFinished(ref.agent)) continue
      const role = ref.agent.role || "agent"
      const list = map.get(role) ?? []
      list.push(ref)
      map.set(role, list)
    }
    // Active agents first, finished ones after; newest first within each.
    for (const list of map.values()) {
      list.sort(
        (left, right) =>
          Number(isAgentFinished(left.agent)) -
            Number(isAgentFinished(right.agent)) ||
          right.agent.updatedAt.localeCompare(left.agent.updatedAt)
      )
    }
    return [...map.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )
  }, [allAgents, hideFinished])

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
        <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md p-1 text-sm text-muted-foreground">
          <span>隐藏已结束</span>
          <Switch
            aria-label="隐藏已结束的 agents"
            checked={hideFinished}
            onCheckedChange={setHideFinished}
          />
        </label>
        {groups.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            没有活跃 agents。
          </p>
        ) : (
          groups.map(([role, refs]) => (
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
                    {refs.map(({ agent }) => {
                      const finish = agentFinishBadge(agent.status)
                      return (
                        <button
                          className={cn(
                            "flex min-w-0 items-center gap-2.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-accent",
                            finish && "opacity-60"
                          )}
                          key={agent.id}
                          onClick={() => onSelectAgent(agent.id)}
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
                              {agent.role === "orchestrator"
                                ? "调度者"
                                : agent.challengeName}
                            </span>
                          </span>
                          {false && (
                            <Badge size="sm" variant="secondary">
                              入口
                            </Badge>
                          )}
                          {finish && (
                            <Badge size="sm" variant={finish.variant}>
                              {finish.label}
                            </Badge>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </CardPanel>
              </Card>
            </section>
          ))
        )}
      </div>
    </ScrollArea>
  )
}
