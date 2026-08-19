import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useSearchParams } from "react-router"

import { agentsApi, eventsApi, keys, schedulerApi, type Challenge } from "@/api"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { POLL_INTERVAL_MS } from "@/features/events/event-agents-shared"
import { ErrorState } from "@/features/events/event-shared"

import { TaskDetail, type TaskTab } from "./task-detail"
import { ORCH, TaskList } from "./task-list"

export function TasksPage() {
  const { eventId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const c = searchParams.get("c")
  const a = searchParams.get("a")
  const [tab, setTab] = useState<TaskTab>(() =>
    a ? "conversation" : "overview"
  )

  const fleet = useQuery({
    enabled: Boolean(eventId),
    queryKey: keys.agents.fleet(eventId ?? ""),
    queryFn: () => agentsApi.getFleet(eventId ?? ""),
    refetchInterval: POLL_INTERVAL_MS,
  })
  const queue = useQuery({
    enabled: Boolean(eventId),
    queryKey: keys.scheduler.queue(eventId ?? ""),
    queryFn: () => schedulerApi.listQueue(eventId ?? ""),
    refetchInterval: POLL_INTERVAL_MS,
  })
  const detail = useQuery({
    enabled: Boolean(eventId),
    queryKey: keys.events.detail(eventId ?? ""),
    queryFn: () => eventsApi.getEvent(eventId ?? ""),
    refetchInterval: POLL_INTERVAL_MS,
  })

  const pendingByChallenge = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of queue.data?.items ?? []) {
      if (item.status !== "pending") continue
      counts.set(item.challengeId, (counts.get(item.challengeId) ?? 0) + 1)
    }
    return counts
  }, [queue.data])

  const challengeById = useMemo(
    () =>
      new Map<string, Challenge>(
        (detail.data?.challenges ?? []).map((challenge) => [
          challenge.id,
          challenge,
        ])
      ),
    [detail.data]
  )

  // Selection lives in the URL (?c=&a=): refresh-safe and shareable.
  const selectTask = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set("c", next)
          params.delete("a")
          return params
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )
  const selectAgent = useCallback(
    (agentId: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set("a", agentId)
          return params
        },
        { replace: true }
      )
      setTab("conversation")
    },
    [setSearchParams]
  )
  /** Drop ?a= so the conversation tab's default derivation takes over
   * (latest live agent — e.g. after a spawn). */
  const clearAgent = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.delete("a")
        return params
      },
      { replace: true }
    )
  }, [setSearchParams])

  // c changed → restart the detail pane on the derived default tab: an
  // explicit ?a= (graph / queue navigation) opens the conversation directly;
  // a bare ?c= lands on the overview. selectTask already drops ?a=. The ref
  // guard keeps ?a=-only changes (agent picks, post-spawn clear) untouched.
  const prevC = useRef(c)
  useEffect(() => {
    if (prevC.current === c) return
    prevC.current = c
    setTab(a ? "conversation" : "overview")
  }, [c, a])

  // Selected challenge deleted → clear the selection back to the empty state.
  useEffect(() => {
    if (!c || c === ORCH || !fleet.data) return
    if (!fleet.data.challenges.some((challenge) => challenge.id === c)) {
      setSearchParams({}, { replace: true })
    }
  }, [c, fleet.data, setSearchParams])

  if (!eventId) return null
  if (fleet.isPending || detail.isPending) {
    return (
      <output className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        正在加载任务…
      </output>
    )
  }
  if (fleet.error) {
    return <ErrorState error={fleet.error} retry={() => fleet.refetch()} />
  }
  if (detail.error) {
    return <ErrorState error={detail.error} retry={() => detail.refetch()} />
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[17.5rem_minmax(0,1fr)] gap-4">
      <TaskList
        challengeById={challengeById}
        fleet={fleet.data}
        onSelect={selectTask}
        pendingByChallenge={pendingByChallenge}
        selected={c}
      />
      {c ? (
        <TaskDetail
          challenge={c === ORCH ? undefined : challengeById.get(c)}
          eventId={eventId}
          fleet={fleet.data}
          queue={{
            items: queue.data?.items ?? [],
            state: queue.data?.state ?? "running",
          }}
          onClearAgent={clearAgent}
          onSelectAgent={selectAgent}
          selection={{ a, c }}
          tab={tab}
          onTabChange={setTab}
        />
      ) : (
        <div className="flex min-h-0 items-center justify-center rounded-lg border border-dashed">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>从左侧选择一项</EmptyTitle>
              <EmptyDescription>
                选择一个题目或调度者，在此查看概览、对话、频道与文件。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}
    </div>
  )
}
