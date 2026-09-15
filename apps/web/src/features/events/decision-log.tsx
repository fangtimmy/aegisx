import { isRecord } from "@aegisx/shared"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { History, RefreshCw } from "lucide-react"
import type { ReactNode } from "react"
import { Fragment } from "react"

import {
  agentsApi,
  type Challenge,
  type DecisionLogEntry,
  eventsApi,
  keys,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { formatDuration, formatTime } from "@/lib/format"

import { roleLabel } from "./event-agents-shared"
import { ErrorState } from "./event-shared"

const PAGE_SIZE = 50

type DecisionBadgeVariant =
  | "secondary"
  | "destructive"
  | "success"
  | "warning"
  | "info"
  | "outline"

/** Chinese label + severity per known event type; unknown types degrade to
 * the raw type string on a neutral outline badge. */
const TYPE_META: Record<
  string,
  { label: string; variant: DecisionBadgeVariant }
> = {
  "queue.enqueued": { label: "入队", variant: "secondary" },
  "queue.launched": { label: "派发", variant: "info" },
  "queue.item_failed": { label: "队列项失败", variant: "destructive" },
  "queue.item_cancelled": { label: "取消排队", variant: "secondary" },
  "queue.item_done": { label: "队列项完成", variant: "success" },
  "queue.reordered": { label: "队列重排", variant: "secondary" },
  "queue.paused": { label: "队列暂停", variant: "warning" },
  "queue.resumed": { label: "队列恢复", variant: "secondary" },
  "queue.item_reset": { label: "队列重置", variant: "warning" },
  "queue.item_removed": { label: "移除队列项", variant: "secondary" },
  "queue.item_edited": { label: "编辑队列项", variant: "secondary" },
  "queue.items_cleared": { label: "清空队列", variant: "warning" },
  "fence.blocked": { label: "Fence 拒绝", variant: "destructive" },
  "flag.submitted": { label: "提交 Flag", variant: "secondary" },
  "flag.accepted": { label: "Flag 通过", variant: "success" },
  "flag.rejected": { label: "Flag 被拒", variant: "destructive" },
  "flag.deleted": { label: "删除 Flag", variant: "secondary" },
  "challenge.imported": { label: "导入题目", variant: "secondary" },
  "challenge.synced": { label: "同步题目", variant: "secondary" },
  "challenge.overridden": { label: "覆写状态", variant: "warning" },
  "challenge.solved": { label: "题目解出", variant: "success" },
  "challenge.progress_reset": { label: "重置进度", variant: "warning" },
  "plan.proposed": { label: "计划提交", variant: "info" },
  "plan.result": { label: "计划结果", variant: "secondary" },
  "decision_point.opened": { label: "决策点开启", variant: "warning" },
  "decision_point.triggered": { label: "触发收集", variant: "secondary" },
  "decision_point.flushed": { label: "触发丢弃", variant: "warning" },
  "decision_point.reprompted": { label: "违约重申", variant: "warning" },
  "decision_point.stall_cleared": { label: "停滞解除", variant: "success" },
  "decision_point.closed": { label: "决策点关闭", variant: "secondary" },
  "watchdog.escalated": { label: "看门狗升级", variant: "destructive" },
  "boot.recovered": { label: "开机恢复", variant: "warning" },
  "agent.spawned": { label: "派生", variant: "info" },
  "agent.started": { label: "开始运行", variant: "secondary" },
  "agent.turn_started": { label: "回合开始", variant: "secondary" },
  "agent.turn_settled": { label: "回合结束", variant: "secondary" },
  "agent.session_prepared": { label: "会话就绪", variant: "secondary" },
  "agent.session_switched": { label: "会话切换", variant: "secondary" },
  "agent.model_switched": { label: "模型切换", variant: "info" },
  "agent.delivered": { label: "消息送达", variant: "secondary" },
  "agent.deadline_armed": { label: "限期布防", variant: "warning" },
  "agent.timed_out": { label: "限期到期", variant: "warning" },
  "agent.reopened": { label: "重新开启", variant: "secondary" },
  "agent.terminated": { label: "终态", variant: "destructive" },
  "agent.deleted": { label: "删除", variant: "secondary" },
  "agent.recovered": { label: "重启复位", variant: "warning" },
}

const FENCE_CODE_LABELS: Record<string, string> = {
  global_capacity: "全局并发已满",
  target_slots: "靶机槽位已满",
  challenge_solved: "题目已解出",
}

const FENCE_VIA_LABELS: Record<string, string> = {
  spawn: "启动",
  queue: "队列",
  manual: "手动",
  plan: "计划",
}

const TIER_LABELS: Record<string, string> = {
  first: "首解",
  extra: "追加",
  partial: "部分匹配",
}

const MANUAL_STATE_LABELS: Record<string, string> = {
  unsolved: "未解决",
  partial: "部分解出",
  solved: "已解决",
}

/** challenge.synced: which projection fields the sync delta carried. */
const SYNC_FIELD_LABELS: Record<string, string> = {
  name: "名称",
  description: "描述",
  category: "分类",
  points: "分值",
  requiredFlags: "所需 Flag 数",
  available: "可用性",
  solved: "已解出",
  targetSupported: "靶机支持",
  targetCount: "靶机数量",
  targetInfo: "靶机信息",
  targetIgnored: "忽略靶机",
}

const SYSTEM_ACTOR_LABELS: Record<string, string> = {
  system: "系统",
  drainer: "排水器",
  "agent-settle": "回合结算",
  "boot-recovery": "启动恢复",
  "solve-cleanup": "解题清理",
  "scheduler-admin": "调度管理",
  "progress-machine": "进度状态机",
  "platform-sync": "平台同步",
}

/** Plan action kinds (design §B vocabulary) for the plan rows. */
const PLAN_ACTION_LABELS: Record<string, string> = {
  enqueue: "入队",
  message: "消息",
  stop: "停止",
  close: "关闭",
  finish: "收官",
  setDeadline: "限期",
  cancelItem: "取消排队",
  reorder: "重排",
  setQueuePaused: "队列暂停",
  noOp: "按兵不动",
}

/** Per-ref rejection codes (shared/plan.ts PlanErrorCode). */
const PLAN_ERROR_CODE_LABELS: Record<string, string> = {
  unknown_challenge: "未知题目",
  unknown_agent: "未知 agent",
  wrong_state: "状态不符",
  duplicate_ref: "重复 ref",
  empty_plan: "空计划",
  model_unresolvable: "模型不可用",
  solved_blocked: "题目已解出",
  self_target: "指向自身",
  schema: "格式错误",
}

/** agent.terminated status: badge color + the row's status word. */
const TERMINAL_STATUS_META: Record<
  string,
  { label: string; variant: DecisionBadgeVariant }
> = {
  completed: { label: "完成", variant: "success" },
  aborted: { label: "中止", variant: "warning" },
  failed: { label: "失败", variant: "destructive" },
}

/** decision_point.closed outcome: badge color + the row's outcome word. */
const DECISION_OUTCOME_META: Record<
  string,
  { label: string; variant: DecisionBadgeVariant }
> = {
  plan: { label: "已交计划", variant: "secondary" },
  violation: { label: "违约", variant: "destructive" },
  error: { label: "回合失败", variant: "warning" },
}

/** decision_point.triggered: the DecisionTrigger kind's readable label
 * (kind-specific facts ride the payload and append below). */
const DECISION_TRIGGER_KIND_LABELS: Record<string, string> = {
  "agent.settled": "agent 回合结束",
  "flag.accepted": "flag 通过",
  "queue.changed": "队列变化",
  "launch.failed": "启动失败",
  "agent.timedOut": "agent 超时",
  "user.directive": "用户指令",
  "solver.asked": "solver 求援",
  "fleet.stalled": "舰队停滞",
  periodic: "例行复核",
  "boot.resync": "重启重同步",
}

/** decision_point.flushed reason: why the pending triggers were dropped. */
const DECISION_FLUSH_REASON_LABELS: Record<string, string> = {
  gated: "闸门拦截（已暂停）",
  no_scheduler: "无调度者",
}

const WATCHDOG_REASON_LABELS: Record<string, string> = {
  fleet_stalled: "舰队停滞",
  scheduler_violation: "调度违约",
}

const TIMED_OUT_OUTCOME_LABELS: Record<string, string> = {
  aborted: "到期中止",
  idle: "到期未运行",
}

const DELIVERY_VIA_LABELS: Record<string, string> = {
  steer: "转向注入",
  followUp: "追问",
  fresh: "新回合",
  cold_resume: "冷唤醒",
}

/** Queue entry source: user / scheduler today, `plan:<planId>` once the
 * scheduler submits plans (control-plane design §B). */
function sourceLabel(source: string | null): string | null {
  if (!source) return null
  if (source === "manual") return "手动"
  if (source === "scheduler") return "调度者"
  if (source === "boot") return "启动恢复"
  if (source.startsWith("plan:")) return `计划 ${shortRef(source.slice(5))}`
  return source
}

/** Cross-reference form for payload-carried ids (planId / decision-point
 * id): a stable short prefix an operator can eyeball-chain across rows. */
function shortRef(id: string): string {
  return id.slice(0, 8)
}

function monoRef(id: string): ReactNode {
  return <span className="font-mono text-muted-foreground">{id}</span>
}

/** plan.proposed: compact per-kind action counts ("3 项动作：入队 ×2、关闭 ×1"). */
function planActionSummary(actions: unknown[]): string {
  if (actions.length === 0) return "空计划"
  const counts = new Map<string, number>()
  for (const action of actions) {
    const kind =
      isRecord(action) && typeof action.kind === "string"
        ? action.kind
        : "unknown"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const breakdown = [...counts.entries()]
    .map(([kind, count]) => `${PLAN_ACTION_LABELS[kind] ?? kind} ×${count}`)
    .join("、")
  return `${actions.length} 项动作：${breakdown}`
}

function payloadString(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function payloadNumber(
  payload: Record<string, unknown>,
  key: string
): number | null {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** The row's primary line: payload facts per type family. Rows carrying a
 * planId / decision-point id append it as muted mono so an operator can
 * eyeball-chain the causation chain (design §2.6). */
function entryMain(
  entry: DecisionLogEntry,
  context: {
    challengeName: string | null
    agentName: (id: string | null) => string | null
  }
): ReactNode {
  const { type, payload } = entry
  const parts: ReactNode[] = []
  if (context.challengeName) parts.push(context.challengeName)

  switch (type) {
    case "queue.enqueued": {
      const ord = payloadNumber(payload, "ord")
      const source = sourceLabel(payloadString(payload, "source"))
      if (ord !== null) parts.push(`#${ord}`)
      if (source) parts.push(source)
      break
    }
    case "queue.launched":
    case "queue.item_done": {
      const name = context.agentName(payloadString(payload, "agentId"))
      if (name) parts.push(`agent ${name}`)
      break
    }
    case "queue.item_failed": {
      const error = payloadString(payload, "error")
      if (error) parts.push(error)
      break
    }
    case "queue.item_cancelled":
    case "queue.item_removed":
    case "queue.item_edited": {
      const itemId = payloadString(payload, "itemId")
      if (itemId) parts.push(`队列项 ${itemId}`)
      break
    }
    case "queue.reordered": {
      const itemIds = payload.itemIds
      if (Array.isArray(itemIds)) parts.push(`重排 ${itemIds.length} 项`)
      break
    }
    case "queue.paused":
    case "queue.resumed": {
      const source = sourceLabel(payloadString(payload, "source"))
      if (source !== null) parts.push(source)
      const planId = payloadString(payload, "planId")
      if (planId !== null) parts.push(monoRef(shortRef(planId)))
      break
    }
    case "queue.item_reset": {
      const count = payloadNumber(payload, "count")
      parts.push(count !== null ? `${count} 项回到队列` : "队列重置")
      break
    }
    case "queue.items_cleared":
      parts.push("清空全部排队")
      break
    case "fence.blocked": {
      const code = payloadString(payload, "code")
      const via = payloadString(payload, "via")
      const message = payloadString(payload, "message")
      const codeLabel = code ? (FENCE_CODE_LABELS[code] ?? code) : null
      const viaLabel = via ? (FENCE_VIA_LABELS[via] ?? via) : null
      if (codeLabel) {
        parts.push(viaLabel ? `${codeLabel}（经${viaLabel}）` : codeLabel)
      }
      if (message) parts.push(message)
      break
    }
    case "flag.submitted":
    case "flag.accepted":
    case "flag.rejected":
    case "flag.deleted": {
      const value = payloadString(payload, "value")
      if (value !== null) parts.push(<span className="font-mono">{value}</span>)
      const extras: string[] = []
      const tier = payloadString(payload, "tier")
      if (tier) extras.push(TIER_LABELS[tier] ?? tier)
      const submitter = context.agentName(payloadString(payload, "submitter"))
      if (submitter) extras.push(submitter)
      const status = payloadString(payload, "status")
      if (status === "error") extras.push("提交异常")
      const message = payloadString(payload, "message")
      if (message) extras.push(message)
      if (extras.length > 0) parts.push(extras.join(" · "))
      break
    }
    case "challenge.imported": {
      const category = payloadString(payload, "category")
      const points = payloadNumber(payload, "points")
      if (category) parts.push(category)
      if (points !== null) parts.push(`${points} 分`)
      break
    }
    case "challenge.synced": {
      const changed = Object.keys(SYNC_FIELD_LABELS).filter(
        (key) => payload[key] !== undefined
      )
      if (changed.length > 0) {
        parts.push(
          `更新 ${changed.map((key) => SYNC_FIELD_LABELS[key]).join("、")}`
        )
      }
      break
    }
    case "challenge.overridden": {
      const state = payloadString(payload, "manualSolveState")
      const stateLabel = state ? (MANUAL_STATE_LABELS[state] ?? state) : null
      if (stateLabel) parts.push(`手动状态 → ${stateLabel}`)
      break
    }
    case "challenge.solved":
      parts.push("进入已解出")
      break
    case "challenge.progress_reset":
      parts.push("重置解题进度")
      break
    case "plan.proposed": {
      const actions = Array.isArray(payload.actions) ? payload.actions : []
      parts.push(planActionSummary(actions))
      const planId = payloadString(payload, "planId")
      if (planId !== null) parts.push(monoRef(shortRef(planId)))
      break
    }
    case "plan.result": {
      const results = Array.isArray(payload.results) ? payload.results : []
      for (const result of results) {
        if (!isRecord(result)) continue
        const ref = typeof result.ref === "string" ? result.ref : "?"
        const kind =
          typeof result.kind === "string"
            ? (PLAN_ACTION_LABELS[result.kind] ?? result.kind)
            : null
        const ok = result.ok === true
        const code =
          typeof result.code === "string"
            ? (PLAN_ERROR_CODE_LABELS[result.code] ?? result.code)
            : null
        let tone = "text-success"
        let word = "成功"
        if (!ok) {
          tone = "text-destructive"
          word = code ?? "失败"
        } else if (
          typeof result.message === "string" &&
          result.message.startsWith("deferred")
        ) {
          tone = "text-muted-foreground"
          word = "已延期"
        }
        parts.push(
          <span>
            <span className="font-mono">{ref}</span>{" "}
            <span className={tone}>
              {kind !== null ? `${kind} ${word}` : word}
            </span>
          </span>
        )
      }
      const planId = payloadString(payload, "planId")
      if (planId !== null) parts.push(monoRef(shortRef(planId)))
      break
    }
    case "decision_point.opened": {
      const id = payloadString(payload, "id")
      if (id !== null) parts.push(monoRef(shortRef(id)))
      break
    }
    case "decision_point.triggered": {
      const kind = payloadString(payload, "kind")
      if (kind !== null) {
        parts.push(DECISION_TRIGGER_KIND_LABELS[kind] ?? kind)
      }
      const preview = payloadString(payload, "preview")
      if (preview !== null) parts.push(preview)
      break
    }
    case "decision_point.flushed": {
      const reason = payloadString(payload, "reason")
      if (reason !== null) {
        parts.push(DECISION_FLUSH_REASON_LABELS[reason] ?? reason)
      }
      const count = payloadNumber(payload, "count")
      if (count !== null && count > 0) parts.push(`丢弃 ${count} 条触发`)
      break
    }
    case "decision_point.reprompted":
    case "decision_point.stall_cleared": {
      const id =
        payloadString(payload, "id") ?? payloadString(payload, "pointId")
      if (id !== null) parts.push(monoRef(shortRef(id)))
      break
    }
    case "decision_point.closed": {
      const outcome = payloadString(payload, "outcome")
      if (outcome !== null) {
        parts.push(DECISION_OUTCOME_META[outcome]?.label ?? outcome)
      }
      const id = payloadString(payload, "id")
      if (id !== null) parts.push(monoRef(shortRef(id)))
      // C 批 additive facts: an all-noOp plan close and the boot-time wrap-up
      // of a point that was still open across a restart.
      if (payload.allNoOp === true) parts.push("全部 noOp")
      if (payloadString(payload, "reason") === "boot") parts.push("重启收尾")
      break
    }
    case "watchdog.escalated": {
      const reason = payloadString(payload, "reason")
      parts.push(
        reason !== null
          ? (WATCHDOG_REASON_LABELS[reason] ?? reason)
          : "升级告警"
      )
      const detail = payload.detail
      if (isRecord(detail)) {
        if (typeof detail.pending === "number") {
          parts.push(`待发 ${detail.pending}`)
        }
        if (typeof detail.stalledMs === "number") {
          parts.push(`停滞 ${formatDuration(detail.stalledMs)}`)
        }
        if (typeof detail.consecutive === "number") {
          parts.push(`连续 ${detail.consecutive} 次无计划`)
        }
        if (
          typeof detail.decisionPointId === "string" &&
          detail.decisionPointId.length > 0
        ) {
          parts.push(monoRef(detail.decisionPointId))
        }
      }
      break
    }
    case "boot.recovered": {
      const liveFlipped = payloadNumber(payload, "liveFlipped") ?? 0
      const queuesReset = payloadNumber(payload, "queuesReset") ?? 0
      const queuesPaused = payloadNumber(payload, "queuesPaused") ?? 0
      if (liveFlipped > 0) parts.push(`复位 ${liveFlipped} 个 agent`)
      if (queuesReset > 0) parts.push("队列重置回待发")
      if (queuesPaused > 0) parts.push("队列已暂停")
      break
    }
    case "agent.spawned": {
      const role = payloadString(payload, "role")
      const name =
        context.agentName(entry.agentId) ??
        payloadString(payload, "name") ??
        (role !== null ? roleLabel(role) : null)
      if (name !== null) parts.push(`agent ${name}`)
      const model = payloadString(payload, "model")
      if (model !== null) parts.push(<span className="font-mono">{model}</span>)
      const source = sourceLabel(payloadString(payload, "source"))
      if (source !== null) parts.push(source)
      break
    }
    case "agent.model_switched": {
      const name = context.agentName(entry.agentId)
      if (name !== null) parts.push(`agent ${name}`)
      const from = payloadString(payload, "from") ?? "—"
      const to = payloadString(payload, "to")
      if (to !== null) {
        parts.push(<span className="font-mono">{`${from} → ${to}`}</span>)
      }
      break
    }
    case "agent.timed_out": {
      const name = context.agentName(entry.agentId)
      if (name !== null) parts.push(`agent ${name}`)
      const outcome = payloadString(payload, "outcome")
      if (outcome !== null) {
        parts.push(TIMED_OUT_OUTCOME_LABELS[outcome] ?? outcome)
      }
      break
    }
    case "agent.delivered": {
      const name = context.agentName(entry.agentId)
      if (name !== null) parts.push(`agent ${name}`)
      const via = payloadString(payload, "via")
      if (via !== null) parts.push(DELIVERY_VIA_LABELS[via] ?? via)
      const chars = payloadNumber(payload, "chars")
      if (chars !== null) parts.push(`${chars} 字符`)
      break
    }
    case "agent.terminated": {
      const name = context.agentName(entry.agentId)
      if (name !== null) parts.push(`agent ${name}`)
      const status = payloadString(payload, "status")
      if (status !== null) {
        parts.push(TERMINAL_STATUS_META[status]?.label ?? status)
      }
      const excerpt =
        payloadString(payload, "summary") ?? payloadString(payload, "error")
      if (excerpt !== null) parts.push(excerpt)
      break
    }
    default:
      // Unknown / future type: the badge carries the type, the challenge name
      // (already pushed above) is the honest remainder. Generic agent.* rows
      // land here too — type label + actor line is the whole story.
      break
  }

  if (parts.length === 0) return null
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && " · "}
      {part}
    </Fragment>
  ))
}

/** The row's muted context line: who produced the fact. */
function entryActor(
  entry: DecisionLogEntry,
  agentName: (id: string | null) => string | null
): string {
  if (entry.actorKind === "user") return "用户"
  if (entry.actorKind === "agent") {
    const name = agentName(entry.actorId ?? entry.agentId)
    return name ? `agent ${name}` : "agent"
  }
  return entry.actorId
    ? (SYSTEM_ACTOR_LABELS[entry.actorId] ?? entry.actorId)
    : "系统"
}

/** The row's optional third block: content that needs its own lines under
 * the summary — the plan's rationale (quote-style) and an opened decision
 * point's trigger list. */
function entryExtra(entry: DecisionLogEntry): ReactNode {
  if (entry.type === "plan.proposed") {
    const rationale = payloadString(entry.payload, "rationale")
    if (rationale !== null) {
      return (
        <p className="mt-1 border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground">
          {rationale}
        </p>
      )
    }
  }
  if (entry.type === "decision_point.opened") {
    const triggers = entry.payload.triggers
    if (Array.isArray(triggers) && triggers.length > 0) {
      const lines = triggers.filter(
        (trigger): trigger is string =>
          typeof trigger === "string" && trigger.length > 0
      )
      if (lines.length > 0) {
        return (
          <div className="mt-1 space-y-0.5 border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground">
            {lines.map((trigger, index) => (
              <p key={index}>{trigger}</p>
            ))}
          </div>
        )
      }
    }
  }
  return null
}

/** The row's type badge. agent.terminated / decision_point.closed re-color
 * by their payload status / outcome (labels stay type-level). */
function entryBadgeMeta(entry: DecisionLogEntry): {
  label: string
  variant: DecisionBadgeVariant
} {
  const meta = TYPE_META[entry.type] ?? {
    label: entry.type,
    variant: "outline" as const,
  }
  let override: { variant: DecisionBadgeVariant } | undefined
  if (entry.type === "agent.terminated") {
    override =
      TERMINAL_STATUS_META[payloadString(entry.payload, "status") ?? ""]
  } else if (entry.type === "decision_point.closed") {
    override =
      DECISION_OUTCOME_META[payloadString(entry.payload, "outcome") ?? ""]
  }
  return override ? { ...meta, variant: override.variant } : meta
}

function DecisionRow({
  entry,
  challengeNames,
  agentNames,
}: {
  entry: DecisionLogEntry
  challengeNames: Map<string, string>
  agentNames: Map<string, string>
}) {
  const meta = entryBadgeMeta(entry)
  const challengeName = entry.challengeId
    ? (challengeNames.get(entry.challengeId) ?? entry.challengeId)
    : null
  const agentName = (id: string | null) =>
    id ? (agentNames.get(id) ?? id) : null
  const main = entryMain(entry, { agentName, challengeName })
  const actor = entryActor(entry, agentName)
  const extra = entryExtra(entry)

  return (
    <div className="flex min-w-0 items-start gap-2.5 border-b px-4 py-2.5 last:border-b-0">
      <Badge className="mt-0.5 shrink-0" size="sm" variant={meta.variant}>
        {meta.label}
      </Badge>
      <div className="min-w-0 flex-1">
        {main !== null && (
          <p className="truncate text-sm font-medium">{main}</p>
        )}
        <p
          className={`truncate text-xs text-muted-foreground${main === null ? "" : " mt-0.5"}`}
        >
          {actor}
        </p>
        {extra}
      </div>
      <time
        className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums"
        dateTime={entry.createdAt}
      >
        {formatTime(entry.createdAt)}
      </time>
    </div>
  )
}

/** 决策日志 tab: the event's control-plane fact log (the decision-log type
 * set), newest first. Poll-on-open — a refresh button + refetch on mount;
 * "加载更多" pages older windows via the `nextBeforeId` cursor. Agent names
 * resolve through the (cached) fleet query. */
export function EventDecisionLog({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
  const log = useInfiniteQuery({
    queryKey: keys.events.decisions(eventId),
    queryFn: ({ pageParam }) =>
      eventsApi.getEventDecisions(eventId, {
        beforeId:
          typeof pageParam === "number" && pageParam > 0
            ? pageParam
            : undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextBeforeId ?? undefined,
  })
  // Names only — the fleet cache is already kept fresh by the other tabs.
  const fleet = useQuery({
    queryKey: keys.agents.fleet(eventId),
    queryFn: () => agentsApi.getFleet(eventId),
  })

  const challengeNames = new Map(challenges.map((c) => [c.id, c.name]))
  const agentNames = new Map<string, string>()
  for (const list of Object.values(fleet.data?.agentsByChallenge ?? {})) {
    for (const agent of list) {
      agentNames.set(agent.id, agent.name ?? roleLabel(agent.role))
    }
  }
  const schedulerAgent = fleet.data?.schedulerAgent
  if (schedulerAgent) {
    agentNames.set(schedulerAgent.id, schedulerAgent.name ?? "调度者")
  }

  const entries = log.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <ScrollArea className="h-full" scrollFade>
      <div className="p-4">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>决策日志</CardFrameTitle>
            <CardFrameDescription>
              控制面事实流水：谁被派了、为什么、fence 拒了什么。
            </CardFrameDescription>
            <CardFrameAction>
              <Button
                loading={log.isRefetching}
                onClick={() => void log.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw /> 刷新
              </Button>
            </CardFrameAction>
          </CardFrameHeader>
          <Card>
            <CardPanel className="p-0">
              {log.isPending ? (
                <output className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  正在加载决策日志…
                </output>
              ) : log.error ? (
                <div className="p-4">
                  <ErrorState
                    error={log.error}
                    retry={() => void log.refetch()}
                  />
                </div>
              ) : entries.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <History className="size-4" />
                  暂无决策记录。
                </div>
              ) : (
                <div className="flex flex-col">
                  {entries.map((entry) => (
                    <DecisionRow
                      agentNames={agentNames}
                      challengeNames={challengeNames}
                      entry={entry}
                      key={entry.id}
                    />
                  ))}
                </div>
              )}
              {log.hasNextPage && entries.length > 0 && (
                <div className="flex justify-center border-t px-4 py-2">
                  <Button
                    disabled={log.isFetchingNextPage}
                    onClick={() => void log.fetchNextPage()}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {log.isFetchingNextPage ? (
                      <Spinner aria-hidden="true" />
                    ) : (
                      <History />
                    )}
                    加载更多
                  </Button>
                </div>
              )}
            </CardPanel>
          </Card>
        </CardFrame>
      </div>
    </ScrollArea>
  )
}
