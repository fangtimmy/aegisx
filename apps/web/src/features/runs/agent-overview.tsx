import type { AgentStatus } from "@/api"

export function statusVariant(status: AgentStatus) {
  if (status === "running") return "info" as const
  if (status === "idle") return "success" as const
  return "secondary" as const
}

/** The single status vocabulary: every view (badges, dots, labels) renders
 * these words for an AgentStatus value. */
export function agentStatusLabel(status: AgentStatus): string {
  if (status === "running") return "运行中"
  if (status === "idle") return "空闲"
  if (status === "completed") return "已完成"
  if (status === "aborted") return "已中断"
  if (status === "failed") return "已失败"
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
