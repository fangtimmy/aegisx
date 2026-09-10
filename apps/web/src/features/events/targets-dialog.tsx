import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock3, Play, RefreshCw, Square } from "lucide-react"
import { useState } from "react"

import { challengesApi, type EventTargetRow, eventsApi, keys } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatTime } from "@/lib/format"
import { toast } from "@/lib/toast"

import { ErrorState } from "./event-shared"

type TargetStatusBadge = {
  text: string
  variant: "success" | "secondary" | "error"
}

function statusOf(
  row: Extract<EventTargetRow, { ok: true }>
): TargetStatusBadge {
  if (row.status === "running") return { text: "运行中", variant: "success" }
  if (row.status === "starting") return { text: "启动中", variant: "secondary" }
  return { text: row.message ? "已回收" : "未启动", variant: "secondary" }
}

/** Event-wide remote-target manager: one live adapter row per target-capable
 * challenge (manual refresh — every row is a platform round-trip), with the
 * per-challenge start/extend/stop actions and a two-step bulk stop. Opened
 * from the event settings' 运行控制 card. */
export function TargetsDialog({
  eventId,
  open,
  onOpenChange,
}: {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [confirmStop, setConfirmStop] = useState(false)
  const targets = useQuery({
    enabled: open,
    queryKey: keys.events.targets(eventId),
    queryFn: () => eventsApi.listEventTargets(eventId),
  })
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.events.targets(eventId) }),
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "challenges" && query.queryKey[2] === "target",
      }),
    ])
  }
  const rowAction = useMutation({
    mutationFn: ({
      challengeId,
      action,
    }: {
      challengeId: string
      action: "start" | "extend" | "stop"
    }) => challengesApi.targetAction(challengeId, action),
    onSuccess: async (_value, { action }) => {
      toast.success(
        action === "start"
          ? "靶机已启动"
          : action === "stop"
            ? "靶机已停止"
            : "已延长"
      )
      await invalidate()
    },
    onError: (error) => toast.error("靶机操作失败", error.message),
  })
  const stopAll = useMutation({
    mutationFn: () => eventsApi.stopEventTargets(eventId),
    onSuccess: async ({ stopped, failures }) => {
      setConfirmStop(false)
      toast.success(
        stopped === 0 && failures.length === 0
          ? "没有运行中的靶机"
          : `已停止 ${stopped} 台靶机${failures.length ? `，${failures.length} 台失败` : ""}`
      )
      await invalidate()
    },
    onError: (error) => {
      setConfirmStop(false)
      toast.error("停止靶机失败", error.message)
    },
  })
  // Disarm the bulk-stop confirmation when it's left hanging. No cleanup on
  // purpose: a stray timer after close is a harmless no-op state write.
  const armStop = () => {
    setConfirmStop(true)
    window.setTimeout(() => setConfirmStop(false), 3_000)
  }

  const items = targets.data?.items ?? []
  const activeCount = items.filter(
    (row) => row.ok && row.status === "running"
  ).length

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>远程靶机</DialogTitle>
          <div className="flex items-center gap-2">
            <Button
              loading={targets.isFetching}
              onClick={() => void targets.refetch()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RefreshCw /> 刷新
            </Button>
            <Button
              disabled={activeCount === 0}
              loading={stopAll.isPending}
              onClick={() => {
                if (!confirmStop) {
                  armStop()
                  return
                }
                stopAll.mutate()
              }}
              size="sm"
              type="button"
              variant={confirmStop ? "destructive" : "destructive-outline"}
            >
              <Square />{" "}
              {confirmStop ? `确认停止 ${activeCount} 台` : "全部停止"}
            </Button>
          </div>
        </DialogHeader>
        <DialogPanel className="min-h-0 flex-1 overflow-y-auto">
          {targets.error ? (
            <ErrorState
              error={targets.error}
              retry={() => void targets.refetch()}
            />
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {targets.isPending
                ? "正在查询靶机状态…"
                : "本赛事没有可管理的靶机。"}
            </p>
          ) : (
            <div className="grid gap-2">
              {items.map((row) => (
                <TargetRowView
                  busy={rowAction.isPending}
                  key={row.challengeId}
                  onAction={(action) =>
                    rowAction.mutate({ challengeId: row.challengeId, action })
                  }
                  row={row}
                />
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function TargetRowView({
  row,
  onAction,
  busy,
}: {
  row: EventTargetRow
  onAction: (action: "start" | "extend" | "stop") => void
  busy: boolean
}) {
  const status: TargetStatusBadge = row.ok
    ? statusOf(row)
    : { text: "不可用", variant: "error" }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {row.name}
          <Badge size="sm" variant={status.variant}>
            {status.text}
          </Badge>
        </p>
        {!row.ok ? (
          <p className="mt-1 truncate text-xs text-destructive">{row.error}</p>
        ) : (
          <>
            {row.endpoints.length > 0 && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {row.endpoints
                  .map((endpoint) => `${endpoint.name} ${endpoint.address}`)
                  .join(" · ")}
              </p>
            )}
            {row.expiresAt && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                过期 {formatTime(row.expiresAt)}
              </p>
            )}
          </>
        )}
      </div>
      {row.ok && (
        <div className="flex shrink-0 items-center gap-1.5">
          {row.status === "absent" && (
            <Button
              disabled={busy}
              onClick={() => onAction("start")}
              size="sm"
              type="button"
              variant="outline"
            >
              <Play /> 启动
            </Button>
          )}
          {row.status === "running" && (
            <>
              <Button
                disabled={busy}
                onClick={() => onAction("extend")}
                size="sm"
                type="button"
                variant="outline"
              >
                <Clock3 /> 延长
              </Button>
              <Button
                disabled={busy}
                onClick={() => onAction("stop")}
                size="sm"
                type="button"
                variant="destructive-outline"
              >
                <Square /> 停止
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
