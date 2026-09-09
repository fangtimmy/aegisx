import type { AgentStatus } from "@/api"

type AgentStatusTone = {
  /** Inline glyph / status-word color. */
  text: string
  /** Status-dot background (task list rows). */
  dot: string
  /** Solid span / bar background (stats timeline). */
  span: string
  /** Badge variant. */
  badge: "info" | "secondary" | "success" | "warning" | "destructive"
}

/** The single status→color mapping behind every status surface (icons, dots,
 * badges, stats spans): blue = working, neutral = waiting, green/amber/red =
 * terminal outcome. Each view picks the channel it renders. */
export const agentStatusVisual: Record<AgentStatus, AgentStatusTone> = {
  running: {
    text: "text-info",
    dot: "bg-info",
    span: "bg-info",
    badge: "info",
  },
  idle: {
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
    span: "bg-secondary",
    badge: "secondary",
  },
  completed: {
    text: "text-success",
    dot: "bg-success",
    span: "bg-success",
    badge: "success",
  },
  aborted: {
    text: "text-warning",
    dot: "bg-warning",
    span: "bg-warning",
    badge: "warning",
  },
  failed: {
    text: "text-destructive",
    dot: "bg-destructive",
    span: "bg-destructive",
    badge: "destructive",
  },
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
