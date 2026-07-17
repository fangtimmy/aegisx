import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  ArrowRight,
  CalendarDays,
  Clock3,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { AppLayout } from "@/components/app-layout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameFooter,
  CardPanel,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import {
  apiRequest,
  type EventInput,
  type EventSummary,
  jsonRequest,
} from "@/lib/api"
import { ErrorState, eventKeys } from "./shared"

const platformLabels = {
  ctfd: "CTFd",
  ret2shell: "Ret2Shell",
  a1ctf: "A1CTF",
} as const

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function EventDialog() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: EventInput) =>
      apiRequest<EventSummary>("/events", jsonRequest("POST", input)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: eventKeys.all })
      setOpen(false)
    },
  })

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      mutation.reset()
    }
  }

  function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    const data = new FormData(formEvent.currentTarget)
    mutation.mutate({
      name: String(data.get("name")).trim(),
    })
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger render={<Button type="button" />}>
        <Plus /> Create event
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create event</DialogTitle>
          <DialogDescription>
            Set up a workspace for challenges and runs.
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input name="name" required type="text" />
            </Field>
            {mutation.error && (
              <Alert variant="error">
                <TriangleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              Create event
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function EventCard({ event }: { event: EventSummary }) {
  const platformLabel = event.platform
    ? platformLabels[event.platform.type]
    : "Local"

  return (
    <CardFrame className="h-full min-w-0" render={<article />}>
      <Card className="flex-1">
        <CardPanel className="flex min-h-32 flex-col justify-center gap-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <h2 className="min-w-0 truncate font-semibold text-base leading-5">
              <Link className="hover:underline" to={`/events/${event.id}`}>
                {event.name}
              </Link>
            </h2>
            <Badge variant="outline">{platformLabel}</Badge>
          </div>
          {event.platform ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium tabular-nums">
                  {event.solvedCount} / {event.challengeCount} solved
                </span>
              </div>
              <Progress
                aria-label={`${event.solvedCount} of ${event.challengeCount} challenges solved`}
                max={Math.max(event.challengeCount, 1)}
                value={event.solvedCount}
              />
            </div>
          ) : (
            <div>
              <p className="text-muted-foreground text-xs">Challenges</p>
              <p className="mt-1 font-semibold text-2xl tabular-nums">
                {event.challengeCount}
              </p>
            </div>
          )}
          {event.activeRunCount > 0 && (
            <Badge className="w-fit" variant="info">
              <Activity /> {event.activeRunCount} active run
              {event.activeRunCount === 1 ? "" : "s"}
            </Badge>
          )}
        </CardPanel>
      </Card>
      <CardFrameFooter className="flex min-h-16 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            <Clock3 className="size-3.5 shrink-0" />
            Updated
            <time dateTime={event.lastActivityAt}>
              {dateTimeFormatter.format(new Date(event.lastActivityAt))}
            </time>
          </span>
          {event.platform && (
            <span className="flex items-center gap-1.5">
              <RefreshCw className="size-3.5 shrink-0" />
              {event.platform.credentialConfigured
                ? event.platform.lastSyncedAt
                  ? `Synced ${dateTimeFormatter.format(new Date(event.platform.lastSyncedAt))}`
                  : "Not synced"
                : "Credentials required"}
            </span>
          )}
        </div>
        <Button render={<Link to={`/events/${event.id}`} />} variant="ghost">
          Open <ArrowRight />
        </Button>
      </CardFrameFooter>
    </CardFrame>
  )
}

export function HomePage() {
  const events = useQuery({
    queryKey: eventKeys.all,
    queryFn: () => apiRequest<{ items: EventSummary[] }>("/events"),
  })

  return (
    <AppLayout>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl">Events</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Manage CTF workspaces, challenges, and run preparation.
          </p>
        </div>
        <EventDialog />
      </div>

      {events.isPending && (
        <div
          className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
          role="status"
        >
          <Spinner aria-hidden="true" />
          Loading events...
        </div>
      )}
      {events.error && (
        <ErrorState error={events.error} retry={() => events.refetch()} />
      )}
      {events.data?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDays />
            </EmptyMedia>
            <EmptyTitle>No events yet</EmptyTitle>
            <EmptyDescription>
              Create an event to begin organizing challenges.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {events.data && events.data.items.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          {events.data.items.map((event) => (
            <EventCard event={event} key={event.id} />
          ))}
        </div>
      )}
    </AppLayout>
  )
}
