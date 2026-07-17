import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, TriangleAlert } from "lucide-react"
import { useNavigate } from "react-router"
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  apiRequest,
  type EventInput,
  type EventSummary,
  jsonRequest,
} from "@/lib/api"
import { PlatformBinding } from "./platform-binding"
import { eventKeys } from "./shared"

export function EventSettings({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const update = useMutation({
    mutationFn: (input: EventInput) =>
      apiRequest<EventSummary>(
        `/events/${event.id}`,
        jsonRequest("PATCH", input)
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(event.id) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
    },
  })
  const remove = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/events/${event.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: eventKeys.all })
      navigate("/")
    },
  })

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="font-semibold text-2xl">Event settings</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Manage this event and its platform connection.
        </p>
      </header>

      <section className="border-t py-6" aria-labelledby="event-general">
        <h2 className="font-medium text-base" id="event-general">
          General
        </h2>
        <form
          className="mt-4 flex max-w-xl items-end gap-3"
          onSubmit={(formEvent) => {
            formEvent.preventDefault()
            const data = new FormData(formEvent.currentTarget)
            update.mutate({ name: String(data.get("name")).trim() })
          }}
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="event-name">Name</FieldLabel>
            <Input
              defaultValue={event.name}
              id="event-name"
              key={event.updatedAt}
              name="name"
              required
            />
          </Field>
          <Button loading={update.isPending} type="submit">
            Save
          </Button>
        </form>
        {update.error && (
          <Alert className="mt-3 max-w-xl" variant="error">
            <TriangleAlert />
            <AlertDescription>{update.error.message}</AlertDescription>
          </Alert>
        )}
      </section>

      <section className="border-t py-6" aria-labelledby="event-platform">
        <h2 className="font-medium text-base" id="event-platform">
          CTF platform
        </h2>
        <p className="mt-1 mb-4 text-muted-foreground text-sm">
          Connect this event to import challenges, attachments, and targets.
        </p>
        <PlatformBinding event={event} />
      </section>

      <section className="border-t py-6" aria-labelledby="event-danger">
        <h2
          className="font-medium text-destructive text-base"
          id="event-danger"
        >
          Danger zone
        </h2>
        <Field className="mt-4 max-w-xl">
          <FieldLabel>Delete event</FieldLabel>
          <FieldDescription>
            Permanently delete this event, its challenges, attachments, and run
            history.
          </FieldDescription>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  className="mt-2 w-fit"
                  type="button"
                  variant="destructive"
                />
              }
            >
              <Trash2 /> Delete event
            </AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {event.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. Active runs must be stopped
                  first.
                </AlertDialogDescription>
                {remove.error && (
                  <Alert variant="error">
                    <TriangleAlert />
                    <AlertDescription>{remove.error.message}</AlertDescription>
                  </Alert>
                )}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  render={<Button type="button" variant="ghost" />}
                >
                  Cancel
                </AlertDialogClose>
                <Button
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                  type="button"
                  variant="destructive"
                >
                  Delete event
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </Field>
      </section>
    </div>
  )
}
