import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useSearchParams } from "react-router"

import { agentsApi, eventsApi, keys, schedulerApi, type Challenge } from "@/api"
import { Skeleton } from "@/components/ui/skeleton"
import { POLL_INTERVAL_MS } from "@/features/events/event-agents-shared"
import { ErrorState } from "@/features/events/event-shared"

import { TaskDetail, type TaskTab } from "./task-detail"
import { ORCH, TaskList } from "./task-list"

const TASK_TAB_VALUES: readonly TaskTab[] = [
  "overview",
  "conversation",
  "channels",
  "files",
  "config",
]

const taskTabKey = (eventId: string) => `aegisx:task-tab:${eventId}`

/** Restore the per-event task tab (概览/对话/频道/文件) from localStorage;
 * config is scheduler-only, so it falls back to conversation for plain
 * challenges. Default: conversation. */
function loadTaskTab(eventId: string, c: string | null): TaskTab {
  const stored = localStorage.getItem(taskTabKey(eventId))
  if (TASK_TAB_VALUES.includes(stored as TaskTab)) {
    if (stored === "config" && c !== ORCH) return "conversation"
    return stored as TaskTab
  }
  return "conversation"
}

export function TasksPage({ active }: { active: boolean }) {
  const { eventId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const c = searchParams.get("c")
  const a = searchParams.get("a")
  const [tab, setTab] = useState<TaskTab>(() =>
    eventId ? loadTaskTab(eventId, c) : "conversation"
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

  // Tab persistence + the c-switch rule: keep the current tab across
  // selections, EXCEPT the scheduler-only config tab when moving to a plain
  // challenge (its panel does not exist there). The ref guard keeps ?a=-only
  // changes (agent picks, post-spawn clear) untouched.
  useEffect(() => {
    if (eventId) localStorage.setItem(taskTabKey(eventId), tab)
  }, [eventId, tab])
  const prevC = useRef(c)
  useEffect(() => {
    if (prevC.current === c) return
    prevC.current = c
    if (c !== ORCH && tab === "config") setTab("conversation")
  }, [c, tab])

  // Selected challenge deleted → clear the selection; the default below then
  // re-selects the scheduler.
  useEffect(() => {
    if (!c || c === ORCH || !fleet.data) return
    if (!fleet.data.challenges.some((challenge) => challenge.id === c)) {
      setSearchParams({}, { replace: true })
    }
  }, [c, fleet.data, setSearchParams])

  // No selection → default to the scheduler overview so the workbench always
  // shows real content instead of an empty placeholder. Gated on the tab
  // being active (panels stay mounted when hidden).
  useEffect(() => {
    if (active && !c && fleet.data) selectTask(ORCH)
  }, [active, c, fleet.data, selectTask])

  if (!eventId) return null
  if (fleet.isPending || detail.isPending) {
    return (
      <div className="grid h-full min-h-0 grid-cols-[17.5rem_minmax(0,1fr)] gap-4">
        <div className="flex min-h-0 flex-col gap-2">
          <Skeleton className="h-8 shrink-0" />
          <div className="flex flex-col gap-1 pr-1">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton className="h-10" key={row} />
            ))}
          </div>
        </div>
        <Skeleton className="min-h-0 rounded-xl" />
      </div>
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
      ) : null}
    </div>
  )
}
