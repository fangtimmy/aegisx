import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock3, Play, RefreshCw, Square } from "lucide-react"

import { challengesApi, keys } from "@/api"
import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { formatTime } from "@/lib/format"
import { toast } from "@/lib/toast"

/** The challenge's remote target panel: status badge + start/extend/stop
 * actions + endpoint list + expiry. Extracted from run-overview (v19) so
 * the tasks-tab agent overview and the agent dialog both reuse it.
 *
 * The target is challenge-scoped (`/api/challenges/:id/target`); the panel
 * only needs the challengeId. */
export function TargetPanel({ challengeId }: { challengeId: string }) {
  const queryClient = useQueryClient()
  const key = keys.challenges.target(challengeId)
  const target = useQuery({
    queryKey: key,
    queryFn: () => challengesApi.getTarget(challengeId),
  })
  const action = useMutation({
    mutationFn: (value: "start" | "extend" | "stop") =>
      challengesApi.targetAction(challengeId, value),
    onSuccess: (value, variables) => {
      queryClient.setQueryData(key, value)
      const verb =
        variables === "start"
          ? "已启动"
          : variables === "stop"
            ? "已停止"
            : "已延长"
      toast.success(`目标 ${verb}`)
    },
    onError: (error) => toast.error("目标操作失败", error.message),
  })
  const value = target.data
  // Unbound challenges have no remote target at all — the panel would sit
  // on "加载中" forever; hide it instead.
  if (target.error instanceof ApiError && target.error.code === "not_bound")
    return null
  // The adapter reports a reclaimed platform target as an explained absent
  // state (status "absent" + message) — the event-over norm, not a fault.
  const recycled = value?.status === "absent" && Boolean(value.message)
  const statusLabel = recycled
    ? "已回收"
    : value?.status === "running"
      ? "运行中"
      : value?.status === "absent"
        ? "未启动"
        : target.error
          ? "不可用"
          : (value?.status ?? "加载中")

  const hasBody =
    Boolean(value && value.endpoints.length > 0) ||
    Boolean(value?.message) ||
    Boolean(value?.expiresAt) ||
    Boolean(target.error || action.error)

  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex items-center gap-2">
            题目目标
            <Badge
              size="sm"
              variant={value?.status === "running" ? "success" : "secondary"}
            >
              {statusLabel}
            </Badge>
          </span>
        </CardFrameTitle>
        <CardFrameAction className="flex items-center gap-2">
          <Button
            aria-label="刷新目标"
            loading={target.isFetching}
            onClick={() => target.refetch()}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw />
          </Button>
          {value?.status === "absent" && !recycled && (
            <Button
              loading={action.isPending}
              onClick={() => action.mutate("start")}
              size="sm"
              type="button"
              variant="outline"
            >
              <Play /> 启动
            </Button>
          )}
          {value?.status === "running" && (
            <>
              <Button
                loading={action.isPending && action.variables === "extend"}
                onClick={() => action.mutate("extend")}
                size="sm"
                type="button"
                variant="outline"
              >
                <Clock3 /> 延长
              </Button>
              <Button
                loading={action.isPending && action.variables === "stop"}
                onClick={() => action.mutate("stop")}
                size="sm"
                type="button"
                variant="destructive-outline"
              >
                <Square /> 停止
              </Button>
            </>
          )}
        </CardFrameAction>
      </CardFrameHeader>
      {hasBody && (
        <Card>
          <CardPanel className="flex flex-col gap-3">
            {value && value.endpoints.length > 0 && (
              <div className="grid gap-2">
                {value.endpoints.map((endpoint) => (
                  <div
                    className="flex min-w-0 items-center justify-between gap-3 text-sm"
                    key={`${endpoint.name}:${endpoint.address}`}
                  >
                    <span className="text-muted-foreground">
                      {endpoint.name}
                    </span>
                    <code className="truncate text-xs">{endpoint.address}</code>
                  </div>
                ))}
              </div>
            )}
            {value?.message && (
              <p className="text-xs text-muted-foreground">{value.message}</p>
            )}
            {value?.expiresAt && (
              <p className="text-xs text-muted-foreground">
                过期时间 {formatTime(value.expiresAt)}
              </p>
            )}
            {(target.error || action.error) && (
              <p className="text-xs text-destructive">
                {(target.error ?? action.error)?.message}
              </p>
            )}
          </CardPanel>
        </Card>
      )}
    </CardFrame>
  )
}
