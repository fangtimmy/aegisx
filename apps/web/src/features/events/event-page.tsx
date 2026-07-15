import { useQuery } from "@tanstack/react-query"
import { Flag, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"
import { ProductHeader } from "@/components/product-header"
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
import { useMediaQuery } from "@/hooks/use-media-query"
import { apiRequest, type Challenge, type EventSummary } from "@/lib/api"
import { ChallengeCard, ChallengeDialog } from "./challenge-card"
import { ErrorState, eventKeys } from "./shared"

export function EventPage() {
  const { eventId, runId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const wideTabs = useMediaQuery("sm")
  const eventQuery = useQuery({
    enabled: Boolean(eventId),
    queryKey: eventKeys.detail(eventId ?? ""),
    queryFn: () =>
      apiRequest<{ event: EventSummary; challenges: Challenge[] }>(
        `/events/${eventId}`
      ),
  })

  if (!eventId) return null

  return (
    <div className="min-h-svh bg-muted/30">
      <ProductHeader eventName={eventQuery.data?.event.name} />
      <main className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
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
              wideTabs ? "items-start gap-6" : "min-w-0 items-stretch gap-4"
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
            orientation={wideTabs ? "vertical" : "horizontal"}
            value={
              location.pathname === `/events/${eventId}/statistics`
                ? "statistics"
                : location.pathname.includes(`/events/${eventId}/run`)
                  ? "run"
                  : "overview"
            }
          >
            <TabsList
              className={
                wideTabs
                  ? "w-36 shrink-0 items-stretch border-r pr-3"
                  : "w-full justify-start overflow-x-auto border-b"
              }
              variant="underline"
            >
              <TabsTab value="overview">Overview</TabsTab>
              <TabsTab value="run">Run</TabsTab>
              <TabsTab value="statistics">Statistics</TabsTab>
            </TabsList>
            <div className="min-w-0 flex-1">
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
                  <ChallengeDialog
                    eventId={eventId}
                    onUploadError={setUploadError}
                  />
                </div>
                {uploadError && (
                  <Alert className="mb-5" variant="warning">
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
                    <EmptyContent>
                      <ChallengeDialog
                        eventId={eventId}
                        onUploadError={setUploadError}
                      />
                    </EmptyContent>
                  </Empty>
                ) : (
                  <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {eventQuery.data.challenges.map((challenge) => (
                      <ChallengeCard
                        challenge={challenge}
                        eventId={eventId}
                        key={challenge.id}
                        onUploadError={setUploadError}
                      />
                    ))}
                  </div>
                )}
              </TabsPanel>
              <TabsPanel value="run">
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
      </main>
    </div>
  )
}
