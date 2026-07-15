import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { AppLayout } from "@/components/app-layout"
import { IconTooltip } from "@/components/product-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  apiRequest,
  type EventInput,
  type EventSummary,
  jsonRequest,
} from "@/lib/api"
import { ErrorState, eventKeys } from "./shared"

function EventDialog({ event }: { event?: EventSummary }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: EventInput) =>
      apiRequest<EventSummary>(
        event ? `/events/${event.id}` : "/events",
        jsonRequest(event ? "PATCH" : "POST", input)
      ),
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
      <DialogTrigger
        render={
          event ? (
            <Button
              aria-label={`Edit ${event.name}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          ) : (
            <Button type="button" />
          )
        }
      >
        {event ? (
          <Pencil />
        ) : (
          <>
            <Plus /> Create event
          </>
        )}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{event ? "Edit event" : "Create event"}</DialogTitle>
          <DialogDescription>
            {event
              ? "Rename this event."
              : "Set up a workspace for challenges and runs."}
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                defaultValue={event?.name}
                name="name"
                required
                type="text"
              />
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
              {event ? "Save changes" : "Create event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function DeleteEventDialog({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/events/${event.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: eventKeys.all }),
  })

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`Delete ${event.name}`}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Trash2 />
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {event.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the event and its challenges.
          </AlertDialogDescription>
          {mutation.error && (
            <Alert variant="error">
              <TriangleAlert />
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="ghost" />}>
            Cancel
          </AlertDialogClose>
          <Button
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            type="button"
            variant="destructive"
          >
            Delete event
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

function EventCard({ event }: { event: EventSummary }) {
  return (
    <Card className="min-w-0" render={<article />}>
      <CardHeader>
        <CardTitle className="min-w-0 pr-16 text-base leading-5">
          <h2>
            <Link className="hover:underline" to={`/events/${event.id}`}>
              {event.name}
            </Link>
          </h2>
        </CardTitle>
        <CardAction className="gap-1">
          <IconTooltip label={`Edit ${event.name}`}>
            <EventDialog event={event} />
          </IconTooltip>
          <IconTooltip label={`Delete ${event.name}`}>
            <DeleteEventDialog event={event} />
          </IconTooltip>
        </CardAction>
      </CardHeader>
      <CardPanel className="text-sm">
        <div>
          <p className="text-muted-foreground text-xs">Challenges</p>
          <p className="mt-1 font-medium">{event.challengeCount}</p>
        </div>
      </CardPanel>
      <CardFooter>
        <Link
          className="font-medium text-sm underline-offset-4 hover:underline"
          to={`/events/${event.id}`}
        >
          Open event
        </Link>
      </CardFooter>
    </Card>
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
          <EmptyContent>
            <EventDialog />
          </EmptyContent>
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
