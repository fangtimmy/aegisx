import type { ActivityItem } from "@aegisx/shared"
import { useQuery } from "@tanstack/react-query"
import {
  Archive,
  CircleAlert,
  Flag,
  Play,
  ScrollText,
  Timer,
  type LucideIcon,
} from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"

import { activityApi, keys } from "@/api"
import { ListRow } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Panel-open-only poll cadence — the log needs no background freshness. */
const POLL_INTERVAL_MS = 15_000

const KIND_META: Record<
  ActivityItem["kind"],
  { icon: LucideIcon; title: string; className: string }
> = {
  flag: {
    icon: Flag,
    title: "Flag 通过",
    className: "border-success/30 bg-success/10 text-success",
  },
  agentSpawn: {
    icon: Play,
    title: "Agent 启动",
    className: "border-info/30 bg-info/10 text-info",
  },
  agentEnd: {
    icon: Archive,
    title: "Agent 结束",
    className: "border-border bg-muted text-muted-foreground",
  },
  timeout: {
    icon: Timer,
    title: "Agent 超时",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  queueFailed: {
    icon: CircleAlert,
    title: "队列项失败",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
}

const END_LABELS: Record<string, string> = {
  completed: "已完成",
  aborted: "已中断",
  failed: "已失败",
}

function rowDetail(item: ActivityItem): string {
  const scope = [item.eventName, item.challengeName ?? "调度者"]
  switch (item.kind) {
    case "flag":
      return [...scope, item.flag ?? ""].filter(Boolean).join(" · ")
    case "agentSpawn":
      return [
        ...scope,
        item.summary === "scheduler" ? "调度者发起" : "手动",
      ].join(" · ")
    case "agentEnd":
      return [
        ...scope,
        END_LABELS[item.agentStatus ?? ""] ?? item.agentStatus ?? "",
        item.summary ?? "",
      ]
        .filter(Boolean)
        .join(" · ")
    default:
      return [...scope, item.summary ?? ""].filter(Boolean).join(" · ")
  }
}

function targetFor(item: ActivityItem): string {
  const base = `/events/${item.eventId}/tasks`
  switch (item.kind) {
    case "flag":
      return `${base}?c=${item.challengeId}`
    case "queueFailed":
      return `${base}?c=orch`
    default:
      return item.challengeId
        ? `${base}?c=${item.challengeId}&a=${item.agentId}`
        : `${base}?c=orch`
  }
}

function ActivityRow({
  item,
  onSelect,
}: {
  item: ActivityItem
  onSelect: (item: ActivityItem) => void
}) {
  const meta = KIND_META[item.kind]
  const Icon = meta.icon
  return (
    <ListRow
      className="gap-2.5 rounded-none border-b px-3 py-2.5 last:border-b-0"
      onClick={() => onSelect(item)}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border",
          meta.className
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{meta.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {rowDetail(item)}
        </span>
      </span>
      <time
        className="shrink-0 text-xs text-muted-foreground"
        dateTime={item.time}
      >
        {formatTime(item.time)}
      </time>
    </ListRow>
  )
}

/** Global activity log: header bell-style popover listing the derived feed
 * (flag / spawn / end / timeout / queue-failure), click-through to tasks. */
export function ActivityLogButton() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const feed = useQuery({
    enabled: open,
    queryKey: keys.activity.all,
    queryFn: () => activityApi.getActivity(),
    refetchInterval: POLL_INTERVAL_MS,
  })

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={<Button aria-label="活动日志" size="icon" variant="ghost" />}
      >
        <ScrollText />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-96 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <h2 className="text-sm font-medium">活动日志</h2>
          {feed.data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {feed.data.items.length}
            </span>
          )}
        </div>
        <ScrollArea className="max-h-[70svh]" scrollFade>
          {feed.isPending && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              正在加载…
            </p>
          )}
          {feed.error && (
            <p className="px-3 py-6 text-center text-sm text-destructive">
              {feed.error.message}
            </p>
          )}
          {feed.data?.items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              暂无活动。
            </p>
          )}
          {feed.data?.items.map((item) => (
            <ActivityRow
              item={item}
              key={item.id}
              onSelect={(selected) => {
                setOpen(false)
                void navigate(targetFor(selected))
              }}
            />
          ))}
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  )
}
