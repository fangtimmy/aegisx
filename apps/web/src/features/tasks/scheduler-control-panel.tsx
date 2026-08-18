import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Pause, Play, Square } from "lucide-react"
import { useState } from "react"

import { keys, schedulerApi, type AgentSummary } from "@/api"
import type { FleetInfo } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StartSchedulerDialog } from "@/features/events/scheduler-config-tab"
import { shortModel } from "@/features/tasks/task-list"
import { toast } from "@/lib/toast"

function isActive(status: AgentSummary["status"]) {
  return status === "running" || status === "idle"
}

/** The scheduler's lifecycle panel (mirrors TargetPanel): status + the
 * start/pause/resume/close actions. Controls live only here — the left
 * column's scheduler row is display-only. */
export function SchedulerControlPanel({
  eventId,
  agent,
  config,
}: {
  eventId: string
  agent: AgentSummary | null
  config: FleetInfo["config"]
}) {
  const queryClient = useQueryClient()
  const [startOpen, setStartOpen] = useState(false)
  const active = agent !== null && isActive(agent.status)
  const paused = config.paused

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: keys.agents.fleet(eventId),
    })
    void queryClient.invalidateQueries({
      queryKey: keys.scheduler.detail(eventId),
    })
    void queryClient.invalidateQueries({
      queryKey: keys.scheduler.inbox(eventId),
    })
  }

  const pause = useMutation({
    mutationFn: () => schedulerApi.pauseScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已暂停")
      invalidate()
    },
    onError: (error) => toast.error("暂停调度者失败", error.message),
  })
  const resume = useMutation({
    mutationFn: () => schedulerApi.resumeScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已恢复")
      invalidate()
    },
    onError: (error) => toast.error("恢复调度者失败", error.message),
  })
  const close = useMutation({
    mutationFn: () => schedulerApi.closeScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已关闭")
      invalidate()
    },
    onError: (error) => toast.error("关闭调度者失败", error.message),
  })

  const statusLabel = !active ? "未启动" : paused ? "已暂停" : "运行中"
  const statusVariant = !active
    ? ("secondary" as const)
    : paused
      ? ("warning" as const)
      : ("success" as const)

  return (
    <section className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">调度者控制</h3>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
        {agent && (
          <span className="text-xs text-muted-foreground">
            {shortModel(agent.model)}
          </span>
        )}
        {active &&
          (paused ? (
            <Button
              loading={resume.isPending}
              onClick={() => resume.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Play /> 恢复
            </Button>
          ) : (
            <Button
              loading={pause.isPending}
              onClick={() => pause.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Pause /> 暂停
            </Button>
          ))}
        {active && (
          <Button
            loading={close.isPending}
            onClick={() => close.mutate()}
            size="sm"
            type="button"
            variant="destructive-outline"
          >
            <Square /> 关闭
          </Button>
        )}
        {!active && (
          <Button onClick={() => setStartOpen(true)} size="sm" type="button">
            <Play /> 启动
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {active
          ? paused
            ? "已暂停：不再调度新任务，容器保持温热。"
            : "运行中：自动规划题目并发起尝试。"
          : "未启动。启动后自动排程（默认冷恢复保留历史记忆）。"}
      </p>
      {startOpen && (
        <StartSchedulerDialog
          config={config}
          eventId={eventId}
          onClose={() => setStartOpen(false)}
          onStarted={invalidate}
        />
      )}
    </section>
  )
}
