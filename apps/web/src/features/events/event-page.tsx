import { useQuery } from "@tanstack/react-query"
import {
  ArrowUpDown,
  Bot,
  Flag,
  LayoutPanelTop,
  ListFilter,
  ListTree,
  Maximize2,
  Minimize2,
  Play,
  Settings,
  TriangleAlert,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"
import { type Challenge, eventsApi, keys } from "@/api"
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
import { OrchestratorView } from "@/features/orchestrator/orchestrator-view"
import { RunsView } from "@/features/runs"
import { ChallengeCard } from "./challenge-card"
import { ChallengeDialog } from "./challenge-dialog"
import { EventSettings } from "./event-settings"
import {
  ErrorState,
  type LocalChallengeStatus,
  localChallengeStatus,
  type RemoteChallengeStatus,
  remoteChallengeStatus,
} from "./event-shared"
import { ImportChallengesDialog } from "./platform-binding"

type EventTab = "overview" | "run" | "orchestrator" | "settings"

function tabFromPath(pathname: string, eventId: string): EventTab {
  if (pathname === `/events/${eventId}/settings`) return "settings"
  if (pathname === `/events/${eventId}/orchestrator`) return "orchestrator"
  if (
    pathname === `/events/${eventId}/run` ||
    pathname.startsWith(`/events/${eventId}/runs/`)
  ) {
    return "run"
  }
  return "overview"
}

function pathForTab(eventId: string, tab: EventTab, runId?: string) {
  if (tab === "run") {
    return runId ? `/events/${eventId}/runs/${runId}` : `/events/${eventId}/run`
  }
  if (tab === "orchestrator") return `/events/${eventId}/orchestrator`
  if (tab === "settings") return `/events/${eventId}/settings`
  return `/events/${eventId}`
}

type ChallengeSort = "event" | "name" | "points"
type ChallengeGroup = "category" | "status" | "none"

const FULLWIDTH_KEY = "aegisx:event-fullwidth"
const UNCATEGORIZED = "Uncategorized"

const LOCAL_STATUS_OPTIONS: Array<{
  value: LocalChallengeStatus
  label: string
}> = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "solved", label: "Solved" },
]

const REMOTE_STATUS_OPTIONS: Array<{
  value: RemoteChallengeStatus
  label: string
}> = [
  { value: "no_remote", label: "No remote" },
  { value: "unsolved", label: "Remote unsolved" },
  { value: "solved", label: "Remote solved" },
  { value: "unavailable", label: "Remote unavailable" },
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
      left.name.localeCompare(right.name, undefined, {
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

  const keyFor = (challenge: Challenge) =>
    group === "category"
      ? challenge.category || UNCATEGORIZED
      : challenge.status === "solved"
        ? "Solved"
        : challenge.status === "in_progress"
          ? "In progress"
          : "Not started"
  const groupKeys = [...new Set(sorted.map(keyFor))]
  return groupKeys.map((key) => ({
    key,
    label: key,
    items: sorted.filter((challenge) => keyFor(challenge) === key),
  }))
}

export function EventPage() {
  const { eventId, runId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [sort, setSort] = useState<ChallengeSort>("event")
  const [group, setGroup] = useState<ChallengeGroup>("category")
  const [categoryFilter, setCategoryFilter] = useState<string[]>([])
  const [localFilter, setLocalFilter] = useState<LocalChallengeStatus[]>([])
  const [remoteFilter, setRemoteFilter] = useState<RemoteChallengeStatus[]>([])
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
        left.localeCompare(right, undefined, {
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
  const workspace = tab === "run" || tab === "orchestrator"

  return (
    <AppLayout
      eventName={eventQuery.data?.event.name}
      fullWidth={fullWidth}
      workspace={workspace}
    >
      {eventQuery.isPending && (
        <div
          className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
          role="status"
        >
          <Spinner aria-hidden="true" />
          Loading event...
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
          className={
            workspace
              ? "h-full min-h-0 w-full items-start gap-4"
              : "items-start gap-4"
          }
          onValueChange={(value) =>
            navigate(pathForTab(eventId, value as EventTab, runId))
          }
          orientation="vertical"
          value={tab}
        >
          <aside
            className={
              workspace
                ? "flex w-40 shrink-0 flex-col self-stretch border-r pr-3"
                : "sticky top-[4.5rem] flex h-[calc(100svh-5.5rem)] w-40 shrink-0 flex-col self-start border-r pr-3"
            }
          >
            <TabsList className="w-full items-stretch" variant="underline">
              <TabsTab className="justify-start gap-2" value="overview">
                <LayoutPanelTop /> Overview
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="run">
                <Play /> Run
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="orchestrator">
                <Bot /> Orchestrator
              </TabsTab>
              <TabsTab className="justify-start gap-2" value="settings">
                <Settings /> Settings
              </TabsTab>
            </TabsList>
            <button
              className="mt-auto flex h-9 w-full shrink-0 cursor-pointer items-center justify-start gap-1.5 rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] text-left text-muted-foreground text-sm transition-colors hover:bg-accent [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:-mx-0.5 [&_svg]:shrink-0"
              onClick={toggleFullWidth}
              type="button"
            >
              {fullWidth ? <Minimize2 /> : <Maximize2 />}
              {fullWidth ? "Normal width" : "Full width"}
            </button>
          </aside>
          <div
            className={
              workspace
                ? "flex min-h-0 min-w-0 flex-1 self-stretch"
                : "min-w-0 flex-1"
            }
          >
            <TabsPanel value="overview">
              <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <h1 className="truncate font-semibold text-2xl">
                    {eventQuery.data.event.name}
                  </h1>
                  <Badge variant="secondary">
                    {activeFilterCount > 0
                      ? `${filteredChallenges.length} / ${eventQuery.data.challenges.length}`
                      : eventQuery.data.challenges.length}{" "}
                    challenges
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
                          Filter
                          {activeFilterCount > 0 && (
                            <Badge size="sm" variant="secondary">
                              {activeFilterCount}
                            </Badge>
                          )}
                        </MenuTrigger>
                        <MenuPopup align="end" className="min-w-56">
                          <MenuGroup>
                            <MenuGroupLabel>Category</MenuGroupLabel>
                            {categoryOptions.map((category) => (
                              <MenuCheckboxItem
                                checked={categoryFilter.includes(category)}
                                key={category}
                                onCheckedChange={(checked) =>
                                  setCategoryFilter((values) =>
                                    toggleInSet(values, category, checked)
                                  )
                                }
                              >
                                {category}
                              </MenuCheckboxItem>
                            ))}
                          </MenuGroup>
                          <MenuSeparator />
                          <MenuGroup>
                            <MenuGroupLabel>Local status</MenuGroupLabel>
                            {LOCAL_STATUS_OPTIONS.map((option) => (
                              <MenuCheckboxItem
                                checked={localFilter.includes(option.value)}
                                key={option.value}
                                onCheckedChange={(checked) =>
                                  setLocalFilter((values) =>
                                    toggleInSet(values, option.value, checked)
                                  )
                                }
                              >
                                {option.label}
                              </MenuCheckboxItem>
                            ))}
                          </MenuGroup>
                          <MenuSeparator />
                          <MenuGroup>
                            <MenuGroupLabel>Remote status</MenuGroupLabel>
                            {REMOTE_STATUS_OPTIONS.map((option) => (
                              <MenuCheckboxItem
                                checked={remoteFilter.includes(option.value)}
                                key={option.value}
                                onCheckedChange={(checked) =>
                                  setRemoteFilter((values) =>
                                    toggleInSet(values, option.value, checked)
                                  )
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
                                onClick={() => {
                                  setCategoryFilter([])
                                  setLocalFilter([])
                                  setRemoteFilter([])
                                }}
                              >
                                Clear filters
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
                            ? "Category"
                            : group === "status"
                              ? "Status"
                              : "No groups"}
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuRadioGroup
                            onValueChange={(value) =>
                              setGroup(value as ChallengeGroup)
                            }
                            value={group}
                          >
                            <MenuRadioItem value="category">
                              Category
                            </MenuRadioItem>
                            <MenuRadioItem value="status">Status</MenuRadioItem>
                            <MenuRadioItem value="none">
                              No groups
                            </MenuRadioItem>
                          </MenuRadioGroup>
                        </MenuPopup>
                      </Menu>
                      <Menu>
                        <MenuTrigger
                          render={<Button type="button" variant="outline" />}
                        >
                          <ArrowUpDown />
                          {sort === "event"
                            ? "Event order"
                            : sort === "name"
                              ? "Name"
                              : "Points"}
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuRadioGroup
                            onValueChange={(value) =>
                              setSort(value as ChallengeSort)
                            }
                            value={sort}
                          >
                            <MenuRadioItem value="event">
                              Event order
                            </MenuRadioItem>
                            <MenuRadioItem value="name">Name</MenuRadioItem>
                            <MenuRadioItem value="points">
                              Points: high to low
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
                  <AlertTitle>Attachment upload failed</AlertTitle>
                  <AlertDescription>{uploadError}</AlertDescription>
                </Alert>
              )}
              {eventQuery.data.challenges.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Flag />
                    </EmptyMedia>
                    <EmptyTitle>No challenges</EmptyTitle>
                    <EmptyDescription>
                      Add the first challenge for this event.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : filteredChallenges.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ListFilter />
                    </EmptyMedia>
                    <EmptyTitle>No matching challenges</EmptyTitle>
                    <EmptyDescription>
                      Clear or adjust filters to see challenges again.
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
                            <h2 className="font-medium text-sm">
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
            <TabsPanel className="min-h-0" value="run">
              <RunsView
                challenges={eventQuery.data.challenges}
                eventId={eventId}
                runId={runId}
              />
            </TabsPanel>
            <TabsPanel className="min-h-0" value="orchestrator">
              <OrchestratorView eventId={eventId} />
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
