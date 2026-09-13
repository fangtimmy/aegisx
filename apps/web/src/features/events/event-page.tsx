import { useQuery } from "@tanstack/react-query"
import {
  ArrowUpDown,
  ChartColumn,
  Crosshair,
  Flag,
  History,
  LayoutPanelTop,
  ListFilter,
  ListTree,
  Maximize2,
  Minimize2,
  Puzzle,
  Settings,
  TriangleAlert,
  Users,
  X,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"

import {
  agentsApi,
  type Challenge,
  type SchedulerInfo,
  eventsApi,
  keys,
} from "@/api"
import { ErrorBoundary } from "@/components/error-boundary"
import { AppLayout } from "@/components/shell/app-layout"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { EventStatsPanel } from "@/features/stats/event-stats"
import { TasksPage } from "@/features/tasks/tasks-page"

import { AgentsGraph } from "./agents-graph"
import { ChallengeCard } from "./challenge-card"
import { ChallengeDialog } from "./challenge-dialog"
import { EventDecisionLog } from "./decision-log"
import { POLL_INTERVAL_MS } from "./event-agents-shared"
import { EventSettings } from "./event-settings"
import {
  ErrorState,
  type LocalChallengeStatus,
  localChallengeStatus,
  type RemoteChallengeStatus,
  remoteChallengeStatus,
} from "./event-shared"
import { EventSummary } from "./event-summary"
import {
  type ChallengeGroup,
  type ChallengeSort,
  isChallengeGroup,
  isChallengeSort,
  useEventViewPrefs,
} from "./event-view-prefs"
import { ImportChallengesDialog } from "./platform-binding"

type EventTab =
  | "overview"
  | "tasks"
  | "agents"
  | "challenges"
  | "decisions"
  | "stats"
  | "settings"

const EVENT_TABS = [
  "overview",
  "tasks",
  "agents",
  "challenges",
  "decisions",
  "stats",
  "settings",
] as const satisfies readonly EventTab[]

function isEventTab(value: string): value is EventTab {
  return EVENT_TABS.some((tab) => tab === value)
}

function tabFromPath(pathname: string, eventId: string): EventTab {
  if (pathname === `/events/${eventId}/settings`) return "settings"
  if (pathname === `/events/${eventId}/stats`) return "stats"
  if (pathname === `/events/${eventId}/decisions`) return "decisions"
  if (pathname === `/events/${eventId}/challenges`) return "challenges"
  if (pathname === `/events/${eventId}/agents`) return "agents"
  if (pathname === `/events/${eventId}/tasks`) return "tasks"
  return "overview"
}

function pathForTab(eventId: string, tab: EventTab) {
  if (tab === "challenges") return `/events/${eventId}/challenges`
  if (tab === "decisions") return `/events/${eventId}/decisions`
  if (tab === "settings") return `/events/${eventId}/settings`
  if (tab === "agents") return `/events/${eventId}/agents`
  if (tab === "tasks") return `/events/${eventId}/tasks`
  if (tab === "stats") return `/events/${eventId}/stats`
  return `/events/${eventId}`
}

const FULLWIDTH_KEY = "aegisx:event-fullwidth"
const UNCATEGORIZED = "未分类"

/** Stable empty fallback so `eventQuery.data?.challenges ?? []` keeps one
   reference between renders (the filter useMemos' deps stay stable). */
const NO_CHALLENGES: Challenge[] = []

const LOCAL_STATUS_OPTIONS: Array<{
  value: LocalChallengeStatus
  label: string
}> = [
  { value: "not_started", label: "未开始" },
  { value: "in_progress", label: "进行中" },
  { value: "solved", label: "已解决" },
]

const REMOTE_STATUS_OPTIONS: Array<{
  value: RemoteChallengeStatus
  label: string
}> = [
  { value: "no_remote", label: "无远端" },
  { value: "unsolved", label: "远端未解决" },
  { value: "solved", label: "远端已解决" },
  { value: "unavailable", label: "远端不可用" },
]

function readFullWidth(): boolean {
  return localStorage.getItem(FULLWIDTH_KEY) !== "0"
}

function toggleInSet<T>(values: T[], value: T, checked: boolean) {
  if (checked) return values.includes(value) ? values : [...values, value]
  return values.filter((item) => item !== value)
}

function filterChallenges(
  challenges: Challenge[],
  categories: string[],
  localStatuses: LocalChallengeStatus[],
  remoteStatuses: RemoteChallengeStatus[]
) {
  return challenges.filter((challenge) => {
    if (categories.length > 0) {
      const category = challenge.category || UNCATEGORIZED
      if (!categories.includes(category)) return false
    }
    if (
      localStatuses.length > 0 &&
      !localStatuses.includes(localChallengeStatus(challenge))
    ) {
      return false
    }
    if (
      remoteStatuses.length > 0 &&
      !remoteStatuses.includes(remoteChallengeStatus(challenge))
    ) {
      return false
    }
    return true
  })
}

function challengeGroups(
  challenges: Challenge[],
  sort: ChallengeSort,
  group: ChallengeGroup
) {
  const sorted = [...challenges]
  if (sort === "name") {
    sorted.sort((left, right) =>
      left.name.localeCompare(right.name, "zh-Hans-CN", {
        numeric: true,
        sensitivity: "base",
      })
    )
  } else if (sort === "points") {
    sorted.sort(
      (left, right) =>
        (right.points ?? Number.NEGATIVE_INFINITY) -
        (left.points ?? Number.NEGATIVE_INFINITY)
    )
  }
  if (group === "none") return [{ key: "all", label: null, items: sorted }]

  const keyFor = (challenge: Challenge) => {
    if (group === "category") return challenge.category || UNCATEGORIZED
    const status = localChallengeStatus(challenge)
    return status === "solved"
      ? "已解决"
      : status === "in_progress"
        ? "进行中"
        : "未开始"
  }
  const groupKeys = [...new Set(sorted.map(keyFor))]
  return groupKeys.map((key) => ({
    key,
    label: key,
    items: sorted.filter((challenge) => keyFor(challenge) === key),
  }))
}

/** Agents tab: the full-width navigation graph (调度者 → 题目 → agent).
 * Node clicks route to the tasks page; lifecycle control lives there. */
function EventAgentsPanel({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
  // Fleet: the single source of truth (agents by challenge + scheduler
  // agent + config/status). Always polls: the scheduler can start/stop
  // agents server-side at any time.
  const fleet = useQuery({
    queryKey: keys.agents.fleet(eventId),
    queryFn: () => agentsApi.getFleet(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })

  const agents = useMemo(
    () => Object.values(fleet.data?.agentsByChallenge ?? {}).flat(),
    [fleet.data]
  )
  const schedulerData = useMemo<SchedulerInfo | undefined>(() => {
    const data = fleet.data
    if (!data) return undefined
    return {
      config: data.config,
      agent: data.schedulerAgent,
      status: data.status,
    }
  }, [fleet.data])

  if (fleet.isPending) {
    return (
      <output className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        正在加载 Agents…
      </output>
    )
  }
  if (fleet.error) {
    return <ErrorState error={fleet.error} retry={() => fleet.refetch()} />
  }

  return (
    <ErrorBoundary>
      <AgentsGraph
        agents={agents}
        challenges={challenges}
        eventId={eventId}
        scheduler={schedulerData}
      />
    </ErrorBoundary>
  )
}

export function EventPage() {
  const { eventId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [prefs, setPrefs] = useEventViewPrefs(eventId)
  const { sort, group, categoryFilter, localFilter, remoteFilter } = prefs
  const [fullWidth, setFullWidth] = useState(readFullWidth)
  const toggleFullWidth = () =>
    setFullWidth((prev) => {
      const next = !prev
      localStorage.setItem(FULLWIDTH_KEY, next ? "1" : "0")
      return next
    })
  const eventQuery = useQuery({
    enabled: Boolean(eventId),
    queryKey: keys.events.detail(eventId ?? ""),
    queryFn: () => eventsApi.getEvent(eventId ?? ""),
  })
  const challenges = eventQuery.data?.challenges ?? NO_CHALLENGES
  const categoryOptions = useMemo(
    () =>
      [
        ...new Set(
          challenges.map((challenge) => challenge.category || UNCATEGORIZED)
        ),
      ].toSorted((left, right) =>
        left.localeCompare(right, "zh-Hans-CN", {
          numeric: true,
          sensitivity: "base",
        })
      ),
    [challenges]
  )
  const filteredChallenges = useMemo(
    () =>
      filterChallenges(challenges, categoryFilter, localFilter, remoteFilter),
    [challenges, categoryFilter, localFilter, remoteFilter]
  )
  const activeFilterCount =
    categoryFilter.length + localFilter.length + remoteFilter.length

  if (!eventId) return null
  const tab = tabFromPath(location.pathname, eventId)

  return (
    <AppLayout eventName={eventQuery.data?.event.name} fullWidth={fullWidth}>
      {eventQuery.isPending && (
        <output className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          正在加载赛事…
        </output>
      )}
      {eventQuery.error && (
        <ErrorState
          error={eventQuery.error}
          retry={() => eventQuery.refetch()}
        />
      )}
      {eventQuery.data && (
        <Tabs
          className="items-start gap-4"
          onValueChange={(value) => {
            if (isEventTab(value)) void navigate(pathForTab(eventId, value))
          }}
          orientation="vertical"
          value={tab}
        >
          <aside className="sticky top-[4.5rem] flex h-[calc(100svh-5.5rem)] w-48 shrink-0 flex-col self-start border-r pr-3">
            <TabsList className="w-full items-stretch" variant="underline">
              <TabsTab className="justify-start gap-2" value="overview">
                <LayoutPanelTop /> 概览
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="tasks">
                <Crosshair /> 任务
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="agents">
                <Users /> Agents
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="challenges">
                <Puzzle /> 题目
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="stats">
                <ChartColumn /> 统计
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="decisions">
                <History /> 决策日志
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="settings">
                <Settings /> 设置
              </TabsTab>
            </TabsList>
            <Button
              className="mt-auto w-full shrink-0 justify-start gap-1.5 px-[calc(--spacing(2.5)-1px)] text-muted-foreground"
              onClick={toggleFullWidth}
              variant="ghost"
            >
              {fullWidth ? <Minimize2 /> : <Maximize2 />}
              {fullWidth ? "标准宽度" : "全宽"}
            </Button>
          </aside>
          <div className="min-w-0 flex-1">
            <TabsPanel className="h-[calc(100svh-5.5rem)]" value="overview">
              <EventSummary
                challenges={eventQuery.data.challenges}
                eventId={eventId}
              />
            </TabsPanel>
            <TabsPanel className="h-[calc(100svh-5.5rem)]" value="tasks">
              <TasksPage active={tab === "tasks"} />
            </TabsPanel>
            <TabsPanel className="h-[calc(100svh-5.5rem)]" value="agents">
              <EventAgentsPanel
                challenges={eventQuery.data.challenges}
                eventId={eventId}
              />
            </TabsPanel>
            <TabsPanel value="challenges">
              <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <h1 className="truncate text-2xl font-semibold">题目</h1>
                  <Badge variant="secondary">
                    {activeFilterCount > 0
                      ? `${filteredChallenges.length} / ${eventQuery.data.challenges.length}`
                      : eventQuery.data.challenges.length}{" "}
                    个题目
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {eventQuery.data.challenges.length > 0 && (
                    <>
                      <Menu>
                        <MenuTrigger
                          render={<Button type="button" variant="outline" />}
                        >
                          <ListFilter />
                          筛选
                          {activeFilterCount > 0 && (
                            <Badge size="sm" variant="secondary">
                              {activeFilterCount}
                            </Badge>
                          )}
                        </MenuTrigger>
                        <MenuPopup align="end" className="min-w-56">
                          <MenuGroup>
                            <MenuGroupLabel>分类</MenuGroupLabel>
                            {categoryOptions.map((category) => (
                              <MenuCheckboxItem
                                checked={categoryFilter.includes(category)}
                                key={category}
                                onCheckedChange={(checked) =>
                                  setPrefs((prev) => ({
                                    ...prev,
                                    categoryFilter: toggleInSet(
                                      prev.categoryFilter,
                                      category,
                                      checked
                                    ),
                                  }))
                                }
                              >
                                {category}
                              </MenuCheckboxItem>
                            ))}
                          </MenuGroup>
                          <MenuSeparator />
                          <MenuGroup>
                            <MenuGroupLabel>本地状态</MenuGroupLabel>
                            {LOCAL_STATUS_OPTIONS.map((option) => (
                              <MenuCheckboxItem
                                checked={localFilter.includes(option.value)}
                                key={option.value}
                                onCheckedChange={(checked) =>
                                  setPrefs((prev) => ({
                                    ...prev,
                                    localFilter: toggleInSet(
                                      prev.localFilter,
                                      option.value,
                                      checked
                                    ),
                                  }))
                                }
                              >
                                {option.label}
                              </MenuCheckboxItem>
                            ))}
                          </MenuGroup>
                          <MenuSeparator />
                          <MenuGroup>
                            <MenuGroupLabel>远端状态</MenuGroupLabel>
                            {REMOTE_STATUS_OPTIONS.map((option) => (
                              <MenuCheckboxItem
                                checked={remoteFilter.includes(option.value)}
                                key={option.value}
                                onCheckedChange={(checked) =>
                                  setPrefs((prev) => ({
                                    ...prev,
                                    remoteFilter: toggleInSet(
                                      prev.remoteFilter,
                                      option.value,
                                      checked
                                    ),
                                  }))
                                }
                              >
                                {option.label}
                              </MenuCheckboxItem>
                            ))}
                          </MenuGroup>
                          {activeFilterCount > 0 && (
                            <>
                              <MenuSeparator />
                              <MenuItem
                                onClick={() =>
                                  setPrefs((prev) => ({
                                    ...prev,
                                    categoryFilter: [],
                                    localFilter: [],
                                    remoteFilter: [],
                                  }))
                                }
                              >
                                清除筛选
                              </MenuItem>
                            </>
                          )}
                        </MenuPopup>
                      </Menu>
                      <Menu>
                        <MenuTrigger
                          render={<Button type="button" variant="outline" />}
                        >
                          <ListTree />
                          {group === "category"
                            ? "按分类"
                            : group === "status"
                              ? "按状态"
                              : "不分组"}
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuRadioGroup
                            onValueChange={(value) => {
                              if (!isChallengeGroup(value)) return
                              setPrefs((prev) => ({
                                ...prev,
                                group: value,
                              }))
                            }}
                            value={group}
                          >
                            <MenuRadioItem value="category">
                              按分类
                            </MenuRadioItem>
                            <MenuRadioItem value="status">按状态</MenuRadioItem>
                            <MenuRadioItem value="none">不分组</MenuRadioItem>
                          </MenuRadioGroup>
                        </MenuPopup>
                      </Menu>
                      <Menu>
                        <MenuTrigger
                          render={<Button type="button" variant="outline" />}
                        >
                          <ArrowUpDown />
                          {sort === "event"
                            ? "赛事顺序"
                            : sort === "name"
                              ? "名称"
                              : "分值"}
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuRadioGroup
                            onValueChange={(value) => {
                              if (!isChallengeSort(value)) return
                              setPrefs((prev) => ({
                                ...prev,
                                sort: value,
                              }))
                            }}
                            value={sort}
                          >
                            <MenuRadioItem value="event">
                              赛事顺序
                            </MenuRadioItem>
                            <MenuRadioItem value="name">名称</MenuRadioItem>
                            <MenuRadioItem value="points">
                              分值：从高到低
                            </MenuRadioItem>
                          </MenuRadioGroup>
                        </MenuPopup>
                      </Menu>
                    </>
                  )}
                  {eventQuery.data.event.platform && (
                    <ImportChallengesDialog eventId={eventId} />
                  )}
                  <ChallengeDialog
                    eventId={eventId}
                    onUploadError={setUploadError}
                  />
                </div>
              </div>
              {uploadError && (
                <Alert className="mb-4" variant="warning">
                  <TriangleAlert />
                  <AlertTitle>附件上传失败</AlertTitle>
                  <AlertDescription>{uploadError}</AlertDescription>
                  <Button
                    aria-label="关闭上传失败提示"
                    data-slot="alert-action"
                    onClick={() => setUploadError(null)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                </Alert>
              )}
              {eventQuery.data.challenges.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Flag />
                    </EmptyMedia>
                    <EmptyTitle>暂无题目</EmptyTitle>
                    <EmptyDescription>
                      为本赛事添加第一个题目。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : filteredChallenges.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ListFilter />
                    </EmptyMedia>
                    <EmptyTitle>没有匹配的题目</EmptyTitle>
                    <EmptyDescription>
                      清除或调整筛选条件以重新查看题目。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid gap-6">
                  {challengeGroups(filteredChallenges, sort, group).map(
                    (challengeGroup) => (
                      <section key={challengeGroup.key}>
                        {challengeGroup.label && (
                          <div className="mb-3 flex items-center gap-2 border-b pb-2">
                            <h2 className="text-sm font-medium">
                              {challengeGroup.label}
                            </h2>
                            <Badge size="sm" variant="secondary">
                              {challengeGroup.items.length}
                            </Badge>
                          </div>
                        )}
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] items-stretch gap-4">
                          {challengeGroup.items.map((challenge) => (
                            <ChallengeCard
                              challenge={challenge}
                              eventId={eventId}
                              key={challenge.id}
                              managed={Boolean(
                                eventQuery.data.event.platform &&
                                challenge.remoteId
                              )}
                              onUploadError={setUploadError}
                            />
                          ))}
                        </div>
                      </section>
                    )
                  )}
                </div>
              )}
            </TabsPanel>
            <TabsPanel className="h-[calc(100svh-5.5rem)]" value="stats">
              <EventStatsPanel eventId={eventId} />
            </TabsPanel>
            <TabsPanel className="h-[calc(100svh-5.5rem)]" value="decisions">
              <EventDecisionLog
                challenges={eventQuery.data.challenges}
                eventId={eventId}
              />
            </TabsPanel>
            <TabsPanel className="pt-0" value="settings">
              <EventSettings event={eventQuery.data.event} />
            </TabsPanel>
          </div>
        </Tabs>
      )}
    </AppLayout>
  )
}
