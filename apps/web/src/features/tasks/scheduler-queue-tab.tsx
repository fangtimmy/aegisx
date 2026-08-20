import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Pause, Play } from "lucide-react"

import { keys, schedulerApi, type QueueItem, type QueueState } from "@/api"
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
import { toast } from "@/lib/toast"

import { QueueList } from "./queue-list"

/** Invalidate the queue + fleet caches after a queue state flip. */
function invalidateQueue(
  queryClient: ReturnType<typeof useQueryClient>,
  eventId: string
) {
  void queryClient.invalidateQueries({
    queryKey: keys.scheduler.queue(eventId),
  })
  void queryClient.invalidateQueries({ queryKey: keys.agents.fleet(eventId) })
}

/** Scheduler-only queue tab: the plan queue as its own view — state badge
 * (running/paused) + pause/resume + the editable QueueList. */
export function SchedulerQueueTab({
  eventId,
  queue,
  onOpenAgent,
}: {
  eventId: string
  queue: { items: QueueItem[]; state: QueueState }
  onOpenAgent: (agentId: string) => void
}) {
  const queryClient = useQueryClient()
  const pauseQueue = useMutation({
    mutationFn: () => schedulerApi.pauseQueue(eventId),
    onSuccess: () => {
      toast.success("队列已暂停")
      invalidateQueue(queryClient, eventId)
    },
    onError: (error) => toast.error("暂停队列失败", error.message),
  })
  const resumeQueue = useMutation({
    mutationFn: () => schedulerApi.resumeQueue(eventId),
    onSuccess: () => {
      toast.success("队列已恢复")
      invalidateQueue(queryClient, eventId)
    },
    onError: (error) => toast.error("恢复队列失败", error.message),
  })
  const visibleQueue = queue.items.filter((item) =>
    ["pending", "running", "failed"].includes(item.status)
  )

  return (
    <ScrollArea className="h-full" scrollFade>
      <div className="p-4">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>
              <span className="flex items-center gap-2">
                计划队列
                <Badge size="sm" variant="secondary">
                  {visibleQueue.length}
                </Badge>
              </span>
            </CardFrameTitle>
            <CardFrameDescription>
              调度者规划或手动入队后，任务将按序启动。
            </CardFrameDescription>
            <CardFrameAction className="flex items-center gap-2">
              <Badge
                size="sm"
                variant={queue.state === "paused" ? "warning" : "success"}
              >
                {queue.state === "paused" ? "已暂停" : "运行中"}
              </Badge>
              {queue.state === "paused" ? (
                <Button
                  loading={resumeQueue.isPending}
                  onClick={() => resumeQueue.mutate()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Play /> 恢复
                </Button>
              ) : (
                <Button
                  loading={pauseQueue.isPending}
                  onClick={() => pauseQueue.mutate()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Pause /> 暂停
                </Button>
              )}
            </CardFrameAction>
          </CardFrameHeader>
          {visibleQueue.length > 0 ? (
            <Card>
              <CardPanel className="p-0">
                <QueueList
                  eventId={eventId}
                  items={visibleQueue}
                  onOpenAgent={onOpenAgent}
                />
              </CardPanel>
            </Card>
          ) : (
            <Card>
              <CardPanel className="text-sm text-muted-foreground">
                队列为空。
              </CardPanel>
            </Card>
          )}
        </CardFrame>
      </div>
    </ScrollArea>
  )
}
