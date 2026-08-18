import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpDown,
  ClipboardList,
  Flag,
  LayoutPanelTop,
  ListChecks,
  ListFilter,
  ListTree,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Puzzle,
  Settings,
  TriangleAlert,
  Users,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"

import {
  type Challenge,
  type QueueItem,
  type QueueState,
  type SchedulerInfo,
  eventsApi,
  keys,
  agentsApi,
  schedulerApi,
} from "@/api"
import { AppLayout } from "@/components/shell/app-layout"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardPanel } from "@/components/ui/card"
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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { toast } from "@/lib/toast"

import { AgentDialog } from "./agent-dialog"
import { AgentsGraph } from "./agents-graph"
import { AgentsTab } from "./agents-tab"
import { ChallengeCard } from "./challenge-card"
import { ChallengeDialog } from "./challenge-dialog"
import { ChallengeImDialog } from "./challenge-im-dialog"
import { ChallengesTreeTab } from "./challenges-tree-tab"
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
  useEventViewPrefs,
} from "./event-view-prefs"
import { ImportChallengesDialog } from "./platform-binding"
import { QueueList } from "./queue-list"
import { TimelineTab } from "./timeline-tab"

type EventTab = "overview" | "agents" | "challenges" | "settings"

function tabFromPath(pathname: string, eventId: string): EventTab {
  if (pathname === `/events/${eventId}/settings`) return "settings"
  if (pathname === `/events/${eventId}/challenges`) return "challenges"
  if (pathname === `/events/${eventId}/agents`) return "agents"
  return "overview"
}

function pathForTab(eventId: string, tab: EventTab) {
  if (tab === "challenges") return `/events/${eventId}/challenges`
  if (tab === "settings") return `/events/${eventId}/settings`
  if (tab === "agents") return `/events/${eventId}/agents`
  return `/events/${eventId}`
}

const FULLWIDTH_KEY = "aegisx:event-fullwidth"
const UNCATEGORIZED = "未分类"

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
  return localStorage.getItem(FULLWIDTH_KEY) === "1"
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

type OverviewTab = "plan" | "timeline" | "challenges" | "agents"

function invalidateQueue(
  queryClient: ReturnType<typeof useQueryClient>,
  eventId: string
) {
  void queryClient.invalidateQueries({
    queryKey: keys.scheduler.queue(eventId),
  })
  void queryClient.invalidateQueries({ queryKey: keys.agents.fleet(eventId) })
}

/** W2.3: queue header with the per-event state badge + pause/resume controls;
 * paused shows a banner (resume re-enables the drainer). */
function PlanPanel({
  eventId,
  queue,
  state,
  onOpenAgent,
}: {
  eventId: string
  queue: QueueItem[]
  state: QueueState
  onOpenAgent: (agentId: string) => void
}) {
  const queryClient = useQueryClient()
  const pause = useMutation({
    mutationFn: () => schedulerApi.pauseQueue(eventId),
    onSuccess: () => {
      toast.success("队列已暂停")
      invalidateQueue(queryClient, eventId)
    },
    onError: (error) => toast.error("暂停队列失败", error.message),
  })
  const resume = useMutation({
    mutationFn: () => schedulerApi.resumeQueue(eventId),
    onSuccess: () => {
      toast.success("队列已恢复")
      invalidateQueue(queryClient, eventId)
    },
    onError: (error) => toast.error("恢复队列失败", error.message),
  })
  const visibleQueue = queue.filter((item) =>
    ["pending", "running", "failed"].includes(item.status)
  )
  return (
    <ScrollArea className="h-full pr-1" scrollFade>
      <div className="flex flex-col gap-3 p-1">
        <div className="flex items-center gap-2 p-1">
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            计划队列
          </h3>
          <Badge size="sm" variant="secondary">
            {visibleQueue.length}
          </Badge>
          <Badge size="sm" variant={state === "paused" ? "warning" : "success"}>
            {state === "paused" ? "已暂停" : "运行中"}
          </Badge>
          <span className="ml-auto">
            {state === "paused" ? (
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
            )}
          </span>
        </div>
        {state === "paused" && (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>队列已暂停</AlertTitle>
            <AlertDescription>队列已暂停，恢复后排空。</AlertDescription>
          </Alert>
        )}
        {visibleQueue.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyTitle>计划队列为空</EmptyTitle>
              <EmptyDescription>
                调度者尚未规划任务。在「题目」中开启任务，或启动调度者让它自行排程。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardPanel className="p-0">
              <QueueList
                eventId={eventId}
                items={visibleQueue}
                onOpenAgent={onOpenAgent}
              />
            </CardPanel>
          </Card>
        )}
      </div>
    </ScrollArea>
  )
}

function EventAgentsPanel({
  eventId,
  challenges,
}: {
  eventId: string
  challenges: Challenge[]
}) {
  const [tab, setTab] = useState<OverviewTab>("agents")
  // W7.1: two independent states — `selected` highlights on the graph (no
  // dialog; sources: AgentsTab click, TimelineTab entry, QueueList 打开) and
  // `dialog` opens AgentDialog (ONLY from graph node clicks).
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<string | null>(null)
  /** Challenge node click → the challenge-level IM (knowledge base). */
  const [challengeIm, setChallengeIm] = useState<string | null>(null)

  // Fleet: the overview's single source of truth (agents by challenge +
  // scheduler agent + config/status) — W7.3 merged the old fleet + scheduler
  // query pair into one endpoint. Always polls: the scheduler can start/stop
  // agents server-side at any time.
  const fleet = useQuery({
    queryKey: keys.agents.fleet(eventId),
    queryFn: () => agentsApi.getFleet(eventId),
    refetchInterval: POLL_INTERVAL_MS,
  })
  // The queue snapshot (independent: plan tab + pause/resume controls).
  const queue = useQuery({
    queryKey: keys.scheduler.queue(eventId),
    queryFn: () => schedulerApi.listQueue(eventId),
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

  const selectAgent = useCallback((agentId: string) => {
    setSelected(agentId)
  }, [])
  const openAgent = useCallback((agentId: string) => {
    setDialog(agentId)
  }, [])

  if (fleet.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载 Agents…
      </div>
    )
  }
  if (fleet.error) {
    return <ErrorState error={fleet.error} retry={() => fleet.refetch()} />
  }

  const imChallenge = challengeIm
    ? (challenges.find((ch) => ch.id === challengeIm) ?? null)
    : null

  return (
    <div className="grid h-full min-h-0 grid-cols-[24rem_minmax(0,1fr)] gap-4">
      <div className="flex min-h-0 min-w-0 flex-col">
        <Tabs className="min-h-0 flex-1" onValueChange={setTab} value={tab}>
          <TabsList className="w-auto justify-start" variant="underline">
            <TabsTab className="gap-1.5" value="plan">
              <ClipboardList /> 计划
            </TabsTab>
            <TabsTab className="gap-1.5" value="timeline">
              <ListChecks /> 时间线
            </TabsTab>
            <TabsTab className="gap-1.5" value="challenges">
              <Puzzle /> 题目
            </TabsTab>
            <TabsTab className="gap-1.5" value="agents">
              <Users /> Agents
            </TabsTab>
          </TabsList>
          <div className="mt-2 min-h-0 flex-1">
            <TabsPanel className="h-full" value="plan">
              <PlanPanel
                eventId={eventId}
                onOpenAgent={selectAgent}
                queue={queue.data?.items ?? []}
                state={queue.data?.state ?? "running"}
              />
            </TabsPanel>
            <TabsPanel className="h-full" value="timeline">
              <TimelineTab
                agents={agents}
                challenges={challenges}
                onSelectAgent={selectAgent}
              />
            </TabsPanel>
            <TabsPanel className="h-full" value="challenges">
              <ChallengesTreeTab challenges={challenges} />
            </TabsPanel>
            <TabsPanel className="h-full" value="agents">
              <AgentsTab
                agents={agents}
                onSelectAgent={selectAgent}
                scheduler={schedulerData}
              />
            </TabsPanel>
          </div>
        </Tabs>
      </div>
      <AgentsGraph
        agents={agents}
        challenges={challenges}
        eventId={eventId}
        onOpenAgent={openAgent}
        onOpenChallenge={setChallengeIm}
        scheduler={schedulerData}
        selected={selected}
      />
      {dialog && (
        <AgentDialog agentId={dialog} onClose={() => setDialog(null)} />
      )}
      {imChallenge && (
        <ChallengeImDialog
          challenge={imChallenge}
          onClose={() => setChallengeIm(null)}
        />
      )}
    </div>
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
  const challenges = eventQuery.data?.challenges ?? []
  const categoryOptions = useMemo(
    () =>
      [
        ...new Set(
          challenges.map((challenge) => challenge.category || UNCATEGORIZED)
        ),
      ].sort((left, right) =>
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
        <div
          className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner aria-hidden="true" />
          正在加载赛事…
        </div>
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
          onValueChange={(value) =>
            navigate(pathForTab(eventId, value as EventTab))
          }
          orientation="vertical"
          value={tab}
        >
          <aside className="sticky top-[4.5rem] flex h-[calc(100svh-5.5rem)] w-40 shrink-0 flex-col self-start border-r pr-3">
            <TabsList className="w-full items-stretch" variant="underline">
              <TabsTab className="justify-start gap-2" value="overview">
                <LayoutPanelTop /> 概览
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="agents">
                <Users /> Agents
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="challenges">
                <Puzzle /> 题目
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="settings">
                <Settings /> 设置
              </TabsTab>
            </TabsList>
            <button
              className="mt-auto flex h-9 w-full shrink-0 cursor-pointer items-center justify-start gap-1.5 rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] text-left text-sm text-muted-foreground transition-colors hover:bg-accent [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
              onClick={toggleFullWidth}
              type="button"
            >
              {fullWidth ? <Minimize2 /> : <Maximize2 />}
              {fullWidth ? "标准宽度" : "全宽"}
            </button>
          </aside>
          <div className="min-w-0 flex-1">
            <TabsPanel className="h-[calc(100svh-5.5rem)]" value="overview">
              <EventSummary
                challenges={eventQuery.data.challenges}
                eventId={eventId}
              />
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
                  <h1 className="truncate text-2xl font-semibold">
                    {eventQuery.data.event.name}
                  </h1>
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
                            onValueChange={(value) =>
                              setPrefs((prev) => ({
                                ...prev,
                                group: value as ChallengeGroup,
                              }))
                            }
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
                            onValueChange={(value) =>
                              setPrefs((prev) => ({
                                ...prev,
                                sort: value as ChallengeSort,
                              }))
                            }
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
                        <div className="grid grid-cols-3 items-stretch gap-4">
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
            <TabsPanel className="pt-0" value="settings">
              <EventSettings event={eventQuery.data.event} />
            </TabsPanel>
          </div>
        </Tabs>
      )}
    </AppLayout>
  )
}
