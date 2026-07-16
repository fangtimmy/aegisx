import { useQuery } from "@tanstack/react-query"
import {
  BarChart3,
  Flag,
  LayoutPanelTop,
  Play,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"
import { AppLayout } from "@/components/app-layout"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { RunsView } from "@/features/runs"
import { EventStatistics } from "@/features/statistics/event-statistics"
import { apiRequest, type Challenge, type EventSummary } from "@/lib/api"
import { ChallengeCard, ChallengeDialog } from "./challenge-card"
import { PlatformBinding } from "./platform-binding"
import { ErrorState, eventKeys } from "./shared"

export function EventPage() {
  const { eventId, runId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [uploadError, setUploadError] = useState<string | null>(null)
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
    location.pathname === `/events/${eventId}/statistics`
      ? "statistics"
      : location.pathname.includes(`/events/${eventId}/run`)
        ? "run"
        : "overview"
  const workspace = tab === "run"

  return (
    <AppLayout eventName={eventQuery.data?.event.name} workspace={workspace}>
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
                  : `/events/${eventId}`
            )
          }
          orientation="vertical"
          value={tab}
        >
          <TabsList
            className="w-40 shrink-0 items-stretch border-r pr-3"
            variant="underline"
          >
            <TabsTab className="justify-start gap-2" value="overview">
              <LayoutPanelTop /> Overview
            </TabsTab>
            <TabsTab className="justify-start gap-2" value="run">
              <Play /> Run
            </TabsTab>
            <TabsTab className="justify-start gap-2" value="statistics">
              <BarChart3 /> Statistics
            </TabsTab>
          </TabsList>
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
                  <PlatformBinding event={eventQuery.data.event} />
                  {!eventQuery.data.event.platformType && (
                    <ChallengeDialog
                      eventId={eventId}
                      onUploadError={setUploadError}
                    />
                  )}
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
                  {!eventQuery.data.event.platformType && (
                    <EmptyContent>
                      <ChallengeDialog
                        eventId={eventId}
                        onUploadError={setUploadError}
                      />
                    </EmptyContent>
                  )}
                </Empty>
              ) : (
                <div className="grid grid-cols-3 items-start gap-4">
                  {eventQuery.data.challenges.map((challenge) => (
                    <ChallengeCard
                      challenge={challenge}
                      eventId={eventId}
                      key={challenge.id}
                      managed={Boolean(eventQuery.data.event.platformType)}
                      onUploadError={setUploadError}
                    />
                  ))}
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
          </div>
        </Tabs>
      )}
    </AppLayout>
  )
}
