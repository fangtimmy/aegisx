import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, TriangleAlert } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { useNavigate } from "react-router"
import { type EventInput, type EventSummary, eventsApi, keys } from "@/api"
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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"
import { PlatformBinding } from "./platform-binding"

export function EventSettings({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const form = useForm<{ name: string; promptHint: string }>({
    defaultValues: { name: event.name, promptHint: event.promptHint ?? "" },
  })
  const update = useMutation({
    mutationFn: (input: EventInput) => eventsApi.updateEvent(event.id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.events.detail(event.id),
        }),
        queryClient.invalidateQueries({ queryKey: keys.events.all }),
      ])
      toast.success("Event updated")
    },
    onError: (error) => toast.error("Failed to update event", error.message),
  })
  const remove = useMutation({
    mutationFn: () => eventsApi.deleteEvent(event.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.events.all })
      toast.success("Event deleted")
      navigate("/")
    },
    onError: (error) => toast.error("Failed to delete event", error.message),
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
          onSubmit={form.handleSubmit((values) =>
            update.mutate({
              name: values.name.trim(),
              promptHint: values.promptHint.trim(),
            })
          )}
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="event-name">Name</FieldLabel>
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  id="event-name"
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                  required
                  type="text"
                  value={field.value}
                />
              )}
              rules={{ required: true }}
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

      <section className="border-t py-6" aria-labelledby="event-prompt-hint">
        <h2 className="font-medium text-base" id="event-prompt-hint">
          Prompt instructions
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Additional instructions appended to every agent prompt for this event
          — flag formats, conventions, common gotchas.
        </p>
        <form
          className="mt-4 max-w-xl"
          onSubmit={form.handleSubmit((values) =>
            update.mutate({
              name: values.name.trim(),
              promptHint: values.promptHint.trim(),
            })
          )}
        >
          <Field>
            <Controller
              control={form.control}
              name="promptHint"
              render={({ field }) => (
                <Textarea
                  id="event-prompt-hint"
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                  placeholder="e.g. Flag format is moectf{...}. Submit only flags matching this format."
                  rows={6}
                  value={field.value}
                />
              )}
            />
          </Field>
          <Button className="mt-3" loading={update.isPending} type="submit">
            Save instructions
          </Button>
        </form>
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
