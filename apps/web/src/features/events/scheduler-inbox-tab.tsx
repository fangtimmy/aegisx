import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { keys, schedulerApi } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

import { POLL_INTERVAL_MS } from "./event-agents-shared"

const PAGE_SIZE = 30

/** mm:ss countdown from epoch ms (negative clamps to 0). */
function countdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false })
}

/**
 * The scheduler agent dialog's inbox tab: live snapshot (pending backlog /
 * notices / emergency lines / silence + stall timers, polled while active)
 * plus the complete delivered-digest history (DB-backed, paginated oldest
 * via "load more"). See docs/scheduler-inbox.md.
 */
export function SchedulerInboxTab({
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
  const history = useInfiniteQuery({
    queryKey: keys.scheduler.inboxDigests(eventId),
    queryFn: ({ pageParam }) =>
      schedulerApi.getInboxDigests(eventId, PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.hasMore ? all.length * PAGE_SIZE : undefined,
    refetchInterval: active ? POLL_INTERVAL_MS : false,
  })

  const snap = snapshot.data
  const backlog =
    snap &&
    (snap.emergency.length > 0 ||
      snap.notices.length > 0 ||
      snap.pending.length > 0)
  const digests = history.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <ScrollArea className="h-full" scrollFade>
      <div className="flex flex-col gap-4 p-6">
        {/* Live state header */}
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

        {/* Pending backlog */}
        {snap && backlog && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              待结算积压
            </h3>
            <div className="flex flex-col gap-1.5">
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
          </section>
        )}
        {snap && !backlog && (
          <p className="text-sm text-muted-foreground">
            收件箱空闲，无待结算事件。
          </p>
        )}
        {!snap && snapshot.isPending && (
          <p className="text-sm text-muted-foreground">正在加载…</p>
        )}

        {/* Delivered-digest history (complete, newest first) */}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            投递历史
            {history.data && (
              <span className="ml-2 text-xs">
                共 {history.data.pages[0]!.total} 条
              </span>
            )}
          </h3>
          {history.isPending && (
            <p className="text-sm text-muted-foreground">正在加载…</p>
          )}
          {history.isSuccess && digests.length === 0 && (
            <p className="text-sm text-muted-foreground">尚无投递记录。</p>
          )}
          <div className="flex flex-col gap-2">
            {digests.map((digest) => (
              <div
                className="rounded-md border bg-muted/40 px-3 py-2"
                key={digest.id}
              >
                <div className="mb-1 font-mono text-xs text-muted-foreground">
                  {timeOf(digest.createdAt)}
                </div>
                <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                  {digest.text}
                </pre>
              </div>
            ))}
          </div>
          {history.hasNextPage && (
            <Button
              disabled={history.isFetchingNextPage}
              onClick={() => history.fetchNextPage()}
              size="sm"
              variant="outline"
            >
              {history.isFetchingNextPage ? "加载中…" : "加载更多"}
            </Button>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}
