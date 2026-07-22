import { useQuery } from "@tanstack/react-query"
import {
  ArrowUpDown,
  BarChart3,
  Flag,
  LayoutPanelTop,
  ListTree,
  Maximize2,
  Minimize2,
  Play,
  Settings,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"
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
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { RunsView } from "@/features/runs"
import { EventStatistics } from "@/features/statistics/event-statistics"
import { apiRequest, type Challenge, type EventSummary } from "@/lib/api"
import { ChallengeCard } from "./challenge-card"
import { ChallengeDialog } from "./challenge-dialog"
import { EventSettings } from "./event-settings"
import { ErrorState, eventKeys } from "./event-shared"
import { ImportChallengesDialog } from "./platform-binding"

type ChallengeSort = "event" | "name" | "points"
type ChallengeGroup = "category" | "status" | "none"

const FULLWIDTH_KEY = "aegisx:event-fullwidth"

function readFullWidth(): boolean {
  return localStorage.getItem(FULLWIDTH_KEY) === "1"
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
      ? challenge.category || "Uncategorized"
      : challenge.status === "solved"
        ? "Solved"
        : challenge.status === "in_progress"
          ? "In progress"
          : "Not started"
  const keys = [...new Set(challenges.map(keyFor))]
  return keys.map((key) => ({
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
  const [fullWidth, setFullWidth] = useState(readFullWidth)
  const toggleFullWidth = () =>
    setFullWidth((prev) => {
      const next = !prev
      localStorage.setItem(FULLWIDTH_KEY, next ? "1" : "0")
      return next
    })
  const eventQuery = useQuery({
    enabled: Boolean(eventId),
    queryKey: eventKeys.detail(eventId ?? ""),
    queryFn: () =>
      apiRequest<{ event: EventSummary; challenges: Challenge[] }>(
        `/events/${eventId}`
      ),
  })

  if (!eventId) return null
  const tab =
    location.pathname === `/events/${eventId}/settings`
      ? "settings"
      : location.pathname === `/events/${eventId}/statistics`
        ? "statistics"
        : location.pathname.includes(`/events/${eventId}/run`)
          ? "run"
          : "overview"
  const workspace = tab === "run"

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
            navigate(
              value === "run"
                ? `/events/${eventId}/run`
                : value === "statistics"
                  ? `/events/${eventId}/statistics`
                  : value === "settings"
                    ? `/events/${eventId}/settings`
                    : `/events/${eventId}`
            )
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
              <TabsTab className="justify-start gap-2" value="statistics">
                <BarChart3 /> Statistics
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
                    {eventQuery.data.challenges.length} challenges
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {eventQuery.data.challenges.length > 0 && (
                    <>
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
              ) : (
                <div className="grid gap-6">
                  {challengeGroups(eventQuery.data.challenges, sort, group).map(
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
            <TabsPanel className="pt-0" value="statistics">
              <EventStatistics eventId={eventId} />
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
