import { useNavigate } from "react-router"

import type { QueueItem } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardPanel } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"

import { QueueList } from "./queue-list"

export function PlanTab({
  eventId,
  queue,
}: {
  eventId: string
  queue: QueueItem[]
}) {
  const navigate = useNavigate()
  const visibleQueue = queue.filter((item) =>
    ["pending", "running", "failed"].includes(item.status)
  )
  if (visibleQueue.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>计划队列为空</EmptyTitle>
          <EmptyDescription>
            调度者尚未规划任务。在「题目」中开启任务，或启动调度者让它自行排程。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-3 p-1">
        <div className="flex items-center gap-2 p-1">
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            计划队列
          </h3>
          <Badge size="sm" variant="secondary">
            {visibleQueue.length}
          </Badge>
        </div>
        <Card>
          <CardPanel className="p-0">
            <QueueList
              eventId={eventId}
              items={visibleQueue}
              onChanged={() => undefined}
              onOpenRun={(runId) =>
                navigate(`/events/${eventId}/runs/${runId}`)
              }
            />
          </CardPanel>
        </Card>
      </div>
    </ScrollArea>
  )
}
