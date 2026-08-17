import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

import { channelsApi, keys, schedulerApi } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ChannelComposer, MessageBubble } from "@/features/runs/channels-view"

import { POLL_INTERVAL_MS } from "./event-agents-shared"

/** mm:ss countdown from epoch ms (negative clamps to 0). */
function countdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

/**
 * The scheduler agent dialog's DM tab (docs/im-channels.md §5.2 — replaces
 * the former inbox tab): a status header (digest timers / hold toggle /
 * backlog) + the scheduler DM timeline (event messages AND recap digests
 * side-by-side — the delivery history is self-contained in the channel) +
 * the composer (a user post flushes the digest immediately).
 */
export function SchedulerDmTab({
  eventId,
  active,
}: {
  eventId: string
  active: boolean
}) {
  // Ticking clock for the countdowns; only runs while the tab is visible.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  const snapshot = useQuery({
    queryKey: keys.scheduler.inbox(eventId),
    queryFn: () => schedulerApi.getInbox(eventId),
    refetchInterval: active ? POLL_INTERVAL_MS : false,
  })
  const channelId = snapshot.data?.channelId ?? null

  const messages = useQuery({
    queryKey: keys.runs.channelMessages(channelId ?? ""),
    enabled: Boolean(channelId),
    queryFn: () => channelsApi.listChannelMessages(channelId!, 0, 100),
    refetchInterval: active ? POLL_INTERVAL_MS : false,
  })
  const timelineRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = timelineRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.data])

  const queryClient = useQueryClient()
  const holdToggle = useMutation({
    mutationFn: (paused: boolean) =>
      paused
        ? schedulerApi.pauseInbox(eventId)
        : schedulerApi.resumeInbox(eventId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.inbox(eventId),
      })
    },
  })

  const snap = snapshot.data
  const backlog =
    snap &&
    (snap.emergency.length > 0 ||
      snap.notices.length > 0 ||
      snap.pending.length > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status header (digest timers / hold / backlog) */}
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {snap ? (
            snap.live ? (
              <Badge size="sm" variant="success">
                运行中
              </Badge>
            ) : (
              <Badge size="sm" variant="secondary">
                未运行
              </Badge>
            )
          ) : (
            <Badge size="sm" variant="secondary">
              加载中…
            </Badge>
          )}
          {snap?.deliveryPaused && (
            <Badge size="sm" variant="warning">
              已暂停（静默收集）
            </Badge>
          )}
          {snap?.silence.armed && snap.silence.flushAt !== null && (
            <Badge size="sm" variant="info">
              静默 {countdown(snap.silence.flushAt - nowMs)} 后结算
            </Badge>
          )}
          {snap?.stallWatch.map(({ runId, dueAt }) => (
            <Badge key={runId} size="sm" variant="warning">
              run-{runId.slice(0, 8)} 停滞检查 {countdown(dueAt - nowMs)}
            </Badge>
          ))}
          {snap?.unreadCount ? (
            <Badge size="sm" variant="outline">
              未读 {snap.unreadCount}
            </Badge>
          ) : null}
          {snap?.live && (
            <Button
              disabled={holdToggle.isPending}
              onClick={() => holdToggle.mutate(!snap.deliveryPaused)}
              size="sm"
              variant="outline"
            >
              {holdToggle.isPending
                ? "…"
                : snap.deliveryPaused
                  ? "恢复投递"
                  : "暂停投递"}
            </Button>
          )}
        </div>
        {snap && backlog && (
          <div className="flex flex-col gap-1">
            {snap.emergency.map((line, index) => (
              <div
                className="flex items-start gap-2 text-sm"
                key={`emergency-${index}`}
              >
                <Badge className="mt-0.5 shrink-0" size="sm" variant="error">
                  紧急
                </Badge>
                <span className="text-destructive-foreground">⚠ {line}</span>
              </div>
            ))}
            {snap.notices.map((line, index) => (
              <div
                className="flex items-start gap-2 text-sm"
                key={`notice-${index}`}
              >
                <Badge className="mt-0.5 shrink-0" size="sm" variant="info">
                  通知
                </Badge>
                <span>{line}</span>
              </div>
            ))}
            {snap.pending.map(({ runId, events }) => (
              <div
                className="flex items-start gap-2 text-sm"
                key={`pending-${runId}`}
              >
                <Badge
                  className="mt-0.5 shrink-0 font-mono"
                  size="sm"
                  variant="outline"
                >
                  run-{runId.slice(0, 8)}
                </Badge>
                <span className="font-mono text-xs leading-5">
                  {events.join(" → ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Timeline (event stream + recap digests side by side) */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!channelId ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            尚无调度者频道（启动调度者后自动创建）。
          </p>
        ) : messages.isPending ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden /> 加载中…
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto py-2" ref={timelineRef}>
            {(messages.data?.items ?? []).length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                尚无消息。
              </p>
            )}
            {(messages.data?.items ?? []).map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
        {channelId && <ChannelComposer channelId={channelId} />}
      </div>
    </div>
  )
}
