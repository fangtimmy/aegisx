import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

import {
  channelsApi,
  keys,
  schedulerApi,
  type ChannelMessageList,
  type ChannelMessagePublic,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { appendChannelMessage } from "@/features/runs/channel-tail"
import {
  ChannelComposer,
  MessageList,
  RECONCILE_INTERVAL_MS,
} from "@/features/runs/channels-view"
import { toast } from "@/lib/toast"
import { parseLiveEvent } from "@/stream/parse-event"

import { POLL_INTERVAL_MS } from "./event-agents-shared"

/** mm:ss countdown from epoch ms (negative clamps to 0). */
function countdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

/**
 * The scheduler agent dialog's DM tab (v18 派生键频道): a status header
 * (orch unread backlog / global flush-tick countdown / per-event delivery
 * hold toggle) + the orch timeline itself (solver asks + system run/queue
 * events + user posts — the event stream; no recap rendering) + the
 * composer (a user post defaults urgent → immediate delivery).
 */
export function SchedulerDmTab({
  eventId,
  active,
}: {
  eventId: string
  active: boolean
}) {
  // Ticking clock for the flush countdown; only runs while the tab is visible.
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
  const channelKey = snapshot.data?.channelKey ?? null

  const messages = useQuery({
    queryKey: keys.channels.messages(channelKey ?? ""),
    enabled: Boolean(channelKey),
    queryFn: () => channelsApi.listChannelMessages(channelKey!, 0, 100),
    // SSE carries live pushes; the poll is a 60s reconciliation backstop.
    refetchInterval: active ? RECONCILE_INTERVAL_MS : false,
  })

  // Live channel pushes for the orch key — same append path as the IM view,
  // but only while the tab is visible.
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!active || !channelKey) return
    const source = new EventSource(`/api/channels/${channelKey}/stream`)
    source.onmessage = (message) => {
      let payload: unknown
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      const event = parseLiveEvent(payload)
      if (event?.type !== "channel.message") return
      const live = event.message as ChannelMessagePublic
      queryClient.setQueryData<ChannelMessageList>(
        keys.channels.messages(channelKey),
        (prev) => appendChannelMessage(prev, live)
      )
    }
    return () => source.close()
  }, [active, channelKey, queryClient])

  const timelineRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = timelineRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.data])

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
    onError: (error) => toast.error("切换投递暂停失败", error.message),
  })

  const snap = snapshot.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status header (orch unread / flush tick / hold) */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5 text-sm">
        {!snap ? (
          <Badge size="sm" variant="secondary">
            加载中…
          </Badge>
        ) : (
          <>
            {snap.deliveryPaused ? (
              <Badge size="sm" variant="warning">
                已暂停（只存不投）
              </Badge>
            ) : snap.nextFlushAt !== null ? (
              <Badge size="sm" variant="info">
                合并投递 {countdown(snap.nextFlushAt - nowMs)}
              </Badge>
            ) : (
              <Badge size="sm" variant="secondary">
                投递循环未运行
              </Badge>
            )}
            {snap.unreadCount > 0 && (
              <Badge size="sm" variant="outline">
                未读 {snap.unreadCount}
              </Badge>
            )}
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
          </>
        )}
      </div>
      {/* Timeline (the orch event stream — no recap) */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!channelKey ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            尚无调度者频道（启动调度者后自动创建）。
          </p>
        ) : messages.isPending ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden /> 正在加载消息…
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pt-1" ref={timelineRef}>
            {(messages.data?.items ?? []).length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                尚无消息。
              </p>
            )}
            <MessageList messages={messages.data?.items ?? []} />
          </div>
        )}
        {channelKey && <ChannelComposer channelKey={channelKey} />}
      </div>
    </div>
  )
}
