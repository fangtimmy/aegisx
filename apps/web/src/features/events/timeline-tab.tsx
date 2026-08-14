import { useMemo } from "react"
import { Link } from "react-router"

import type { Challenge, RunPublic } from "@/api"
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
  runs: RunPublic[]
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
        runId: flag.runId ?? undefined,
      })
    }
  }
  for (const run of runs) {
    events.push({
      time: run.createdAt,
      id: `run:${run.id}:created`,
      kind: "run",
      title: "任务启动",
      detail: `${run.challengeName} · ${run.orchestration} · ${
        run.source === "scheduler" ? "调度者" : "手动"
      }`,
      runId: run.id,
    })
    if (run.lastTimeoutAt) {
      // Outcome is not persisted — infer from the run's current state
      // (a timeout with a still-warm run settled to idle; a closed one
      // was SIGKILLed, spec §8.3).
      events.push({
        time: run.lastTimeoutAt,
        id: `run:${run.id}:timeout`,
        kind: "timeout",
        title: "任务超时",
        detail: `${run.challengeName} · ${
          run.status === "closed" ? "超时未恢复，已强制关闭" : "已恢复"
        }`,
        runId: run.id,
      })
    }
    if (run.completedAt) {
      events.push({
        time: run.completedAt,
        id: `run:${run.id}:closed`,
        kind: "closed",
        title: "任务结束",
        detail: `${run.challengeName}${
          run.summary ? ` · ${run.summary.slice(0, 48)}` : ""
        }`,
        runId: run.id,
      })
    }
  }
  return events.sort((left, right) => right.time.localeCompare(left.time))
}

export function TimelineTab({
  challenges,
  runs,
  eventId,
}: {
  challenges: Challenge[]
  runs: RunPublic[]
  eventId: string
}) {
  const events = useMemo(
    () => buildTimeline(challenges, runs),
    [challenges, runs]
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
                  event.kind === "closed" &&
                    "border-border bg-muted text-muted-foreground",
                  event.kind === "run" && "border-info/30 bg-info/10 text-info",
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
          return event.runId ? (
            <li className="border-b py-2.5 last:border-b-0" key={event.id}>
              <Link
                className="block rounded-md hover:bg-accent"
                to={`/events/${eventId}/runs/${event.runId}`}
              >
                {row}
              </Link>
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
