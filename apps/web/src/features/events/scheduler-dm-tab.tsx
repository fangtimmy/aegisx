import { useQuery } from "@tanstack/react-query"

import { keys, schedulerApi } from "@/api"
import { Badge } from "@/components/ui/badge"
import { ChannelComposer, ChannelTimeline } from "@/features/runs/channels-view"

import { POLL_INTERVAL_MS } from "./event-agents-shared"

/**
 * The scheduler agent dialog's DM tab: a status header (orch unread backlog
 * — the scheduler reads the ledger via its SDK, and the decision-point
 * engine drives its turns) + the orch timeline itself (solver asks + system
 * run/queue events + user posts — the event stream; no recap rendering) +
 * the composer (a user post opens a user.directive decision point).
 */
export function SchedulerDmTab({
  eventId,
  active,
}: {
  eventId: string
  active: boolean
}) {
  const snapshot = useQuery({
    queryKey: keys.scheduler.inbox(eventId),
    queryFn: () => schedulerApi.getInbox(eventId),
    refetchInterval: active ? POLL_INTERVAL_MS : false,
  })
  const channelKey = snapshot.data?.channelKey ?? null
  const snap = snapshot.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status header (orch unread) */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5 text-sm">
        {!snap ? (
          snapshot.error ? (
            <Badge size="sm" variant="destructive">
              状态获取失败
            </Badge>
          ) : (
            <Badge size="sm" variant="secondary">
              加载中…
            </Badge>
          )
        ) : (
          <>
            <Badge size="sm" variant="secondary">
              引擎驱动 · 决策点唤醒
            </Badge>
            {snap.unreadCount > 0 && (
              <Badge size="sm" variant="outline">
                未读 {snap.unreadCount}
              </Badge>
            )}
          </>
        )}
      </div>
      {/* Timeline (the orch event stream — no recap) */}
      <div className="flex min-h-0 flex-1 flex-col">
        {channelKey ? (
          <>
            <ChannelTimeline
              active={active}
              channelKey={channelKey}
              key={channelKey}
            />
            <ChannelComposer channelKey={channelKey} />
          </>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            尚无调度者频道（启动调度者后自动创建）。
          </p>
        )}
      </div>
    </div>
  )
}
