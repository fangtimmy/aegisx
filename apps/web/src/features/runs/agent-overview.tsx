import { Box, CircleAlert } from "lucide-react"

import type { AgentDetail, AgentSummary, AgentStatus } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { formatTime } from "@/lib/format"

import { TargetPanel } from "./target-panel"

export function statusVariant(status: AgentStatus | string) {
  if (status === "running") return "info" as const
  if (status === "idle") return "success" as const
  return "secondary" as const
}

export function agentStatusLabel(status: AgentStatus | string): string {
  if (status === "running") return "运行中"
  if (status === "idle") return "空闲"
  if (status === "completed") return "已完成"
  if (status === "aborted") return "已关闭"
  if (status === "failed") return "失败"
  return status
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function AgentOverview({
  detail,
  siblings,
}: {
  detail: AgentDetail
  /** The challenge's other agents (the roster + spawn entry). Absent for the
   * scheduler agent. */
  siblings?: AgentSummary[]
}) {
  const { agent, workspace, usage } = detail
  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      <Alert>
        <Box />
        <AlertTitle>容器工具箱</AlertTitle>
        <AlertDescription>
          agent 在宿主机端以进程内方式运行；该容器是一个 Kali 工具箱。bash
          在其中运行，配备完整 CTF
          工具链，其工作区与你的宿主机文件工具共享。可在「对话」标签页中监控并干预它。
        </AlertDescription>
      </Alert>
      {agent.challengeId && <TargetPanel challengeId={agent.challengeId} />}
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">状态</dt>
          <dd className="mt-1">
            <Badge variant={statusVariant(agent.status)}>
              {agentStatusLabel(agent.status)}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">模型</dt>
          <dd className="mt-1 font-mono text-xs break-all">
            {agent.model ?? "默认模型"}
          </dd>
        </div>
        {workspace && (
          <>
            <div>
              <dt className="text-xs text-muted-foreground">容器</dt>
              <dd className="mt-1">
                <Badge
                  variant={workspace.containerRunning ? "success" : "secondary"}
                >
                  {workspace.containerRunning ? "运行中" : "未运行"}
                </Badge>{" "}
                <span className="text-xs text-muted-foreground">
                  同题 {workspace.liveAgentCount} 个 live agent
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">资源</dt>
              <dd className="mt-1 font-mono text-xs">
                {workspace.cpus} CPU · {workspace.memoryMb}MB ·{" "}
                {workspace.pidsLimit} PID
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">镜像</dt>
              <dd className="mt-1 font-mono text-xs break-all">
                {workspace.image || "不可用"}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt className="text-xs text-muted-foreground">开始时间</dt>
          <dd className="mt-1">{formatTime(agent.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">完成时间</dt>
          <dd className="mt-1">{formatTime(agent.completedAt)}</dd>
        </div>
      </dl>
      {siblings && siblings.length > 0 && agent.challengeId && (
        <SiblingRoster agents={siblings} />
      )}
      {usage && (
        <section className="border-t pt-4">
          <h3 className="mb-2 text-sm font-medium">Token 用量与费用</h3>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
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
            <div>
              <dt className="text-xs text-muted-foreground">轮次</dt>
              <dd className="mt-0.5 font-mono text-xs">{usage.turns}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">费用</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {formatCost(usage.cost)}
              </dd>
            </div>
          </dl>
        </section>
      )}
      {(agent.summary || agent.error) && (
        <section className="border-t pt-4">
          <h3 className="mb-2 text-sm font-medium">结果</h3>
          {agent.summary && (
            <p className="text-sm leading-6 whitespace-pre-wrap">
              {agent.summary}
            </p>
          )}
          {agent.error && (
            <Alert variant="error">
              <CircleAlert />
              <AlertTitle>任务失败</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">
                {agent.error}
              </AlertDescription>
            </Alert>
          )}
        </section>
      )}
    </div>
  )
}

/** The challenge's agent roster (the overview's sibling花名册): one row per
 * agent that ever attacked the challenge (history included). */
function SiblingRoster({ agents }: { agents: AgentSummary[] }) {
  return (
    <section className="border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">同题 Agents</h3>
      </div>
      <div className="mt-3 divide-y overflow-hidden rounded-lg border">
        {agents.map((agent) => (
          <div className="flex items-center gap-3 px-3 py-2" key={agent.id}>
            <AgentStatusIcon status={agent.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {agent.name ?? `agent-${agent.id.slice(0, 8)}`}
              </div>
              <code className="text-[11px] text-muted-foreground">
                {agentStatusLabel(agent.status)}
              </code>
            </div>
            <code className="truncate font-mono text-[11px] text-muted-foreground">
              {agent.model ?? "默认模型"}
            </code>
          </div>
        ))}
      </div>
    </section>
  )
}
