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
import { formatTime } from "@/lib/format"

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

/** Chinese label + severity per known event type; types outside the map
 * (future batches: plan.* / decision_point.* / agent.*) degrade to the raw
 * type string on a neutral outline badge. */
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

/** Queue entry source: user / scheduler today, `plan:<planId>` once the
 * scheduler submits plans (control-plane design §B). */
function sourceLabel(source: string | null): string | null {
  if (!source) return null
  if (source === "manual") return "手动"
  if (source === "scheduler") return "调度者"
  if (source === "boot") return "启动恢复"
  if (source.startsWith("plan:")) return `计划 ${source.slice("plan:".length)}`
  return source
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

/** The row's primary line: payload facts per type family. plan.* /
 * decision_point.* entries (later batches) slot their rationale as a third
 * muted line under this summary — the row layout already reserves the space. */
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
      if (source) parts.push(source)
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
    default:
      // Unknown / future type: the badge carries the type, the challenge name
      // (already pushed above) is the honest remainder.
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

function DecisionRow({
  entry,
  challengeNames,
  agentNames,
}: {
  entry: DecisionLogEntry
  challengeNames: Map<string, string>
  agentNames: Map<string, string>
}) {
  const meta = TYPE_META[entry.type] ?? {
    label: entry.type,
    variant: "outline" as const,
  }
  const challengeName = entry.challengeId
    ? (challengeNames.get(entry.challengeId) ?? entry.challengeId)
    : null
  const agentName = (id: string | null) =>
    id ? (agentNames.get(id) ?? id) : null
  const main = entryMain(entry, { agentName, challengeName })
  const actor = entryActor(entry, agentName)

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
        {/* plan.* / decision_point.* rationale renders as a third muted line
        here once those types land (control-plane design §B). */}
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
