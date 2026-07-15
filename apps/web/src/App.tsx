import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  CalendarDays,
  Download,
  FileArchive,
  Flag,
  Pencil,
  Play,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"
import {
  createBrowserRouter,
  Link,
  RouterProvider,
  useLocation,
  useNavigate,
  useParams,
} from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardDescription,
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  type Attachment,
  apiRequest,
  type Challenge,
  type ChallengeInput,
  type EventInput,
  type EventSummary,
  jsonRequest,
  type SettingsPublic,
} from "@/lib/api"
import { CreateRunDialog, RunsView } from "@/runs"
import { EventStatistics } from "@/statistics"

const eventKeys = {
  all: ["events"] as const,
  detail: (id: string) => ["events", id] as const,
}

function getOptionalDate(value: FormDataEntryValue | null) {
  return typeof value === "string" && value
    ? new Date(value).toISOString()
    : null
}

function toLocalDateTime(value: string | null) {
  if (!value) {
    return ""
  }

  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not scheduled"
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <Alert className="rounded-lg" variant="error">
      <TriangleAlert />
      <AlertTitle>Unable to load data</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      <Button onClick={retry} size="sm" type="button" variant="outline">
        Try again
      </Button>
    </Alert>
  )
}

function IconTooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  )
}

function ProductHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          aria-label="AegisX events"
          className="flex items-center gap-3 font-semibold text-lg"
          to="/"
        >
          <span className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
            <ShieldCheck className="size-5" />
          </span>
          AegisX
        </Link>
        <IconTooltip label="Settings">
          <Button
            aria-label="Settings"
            render={<Link to="/settings" />}
            size="icon"
            variant="ghost"
          >
            <Settings />
          </Button>
        </IconTooltip>
      </div>
    </header>
  )
}

type SettingsInput = Pick<
  SettingsPublic,
  | "providerType"
  | "provider"
  | "modelId"
  | "baseUrl"
  | "environment"
  | "containerImage"
  | "cpus"
  | "memoryMb"
  | "pidsLimit"
  | "maxConcurrency"
> & { apiKey?: string | null }

function SettingsForm({ settings }: { settings: SettingsPublic }) {
  const queryClient = useQueryClient()
  const [providerType, setProviderType] = useState(settings.providerType)
  const [environment, setEnvironment] = useState(settings.environment)
  const [clearApiKey, setClearApiKey] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const mutation = useMutation({
    mutationFn: (input: SettingsInput) =>
      apiRequest<SettingsPublic>("/settings", jsonRequest("PATCH", input)),
    onSuccess: (saved) => {
      setClearApiKey(false)
      setApiKey("")
      queryClient.setQueryData(["settings"], saved)
    },
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      providerType,
      provider: String(data.get("provider")).trim(),
      modelId: String(data.get("modelId")).trim(),
      baseUrl:
        providerType === "openai-compatible"
          ? String(data.get("baseUrl") ?? "").trim() || null
          : null,
      environment,
      containerImage: String(data.get("containerImage")).trim(),
      cpus: Number(data.get("cpus")),
      memoryMb: Number(data.get("memoryMb")),
      pidsLimit: Number(data.get("pidsLimit")),
      maxConcurrency: Number(data.get("maxConcurrency")),
      ...(clearApiKey
        ? { apiKey: null }
        : apiKey.trim()
          ? { apiKey: apiKey.trim() }
          : {}),
    })
  }

  const selectClass =
    "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"

  return (
    <form className="space-y-8" onSubmit={submit}>
      <section aria-labelledby="model-settings" className="border-t pt-6">
        <h2 className="font-semibold text-base" id="model-settings">
          Model provider
        </h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="provider-type">Provider type</FieldLabel>
            <select
              className={selectClass}
              id="provider-type"
              name="providerType"
              onChange={(event) =>
                setProviderType(
                  event.target.value as SettingsPublic["providerType"]
                )
              }
              value={providerType}
            >
              <option value="builtin">Built in</option>
              <option value="openai-compatible">OpenAI compatible</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-provider">Provider</FieldLabel>
            <Input
              defaultValue={settings.provider}
              id="settings-provider"
              name="provider"
              required
              type="text"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-model">Model ID</FieldLabel>
            <Input
              defaultValue={settings.modelId}
              id="settings-model"
              name="modelId"
              required
              type="text"
            />
          </Field>
          {providerType === "openai-compatible" && (
            <Field>
              <FieldLabel htmlFor="settings-base-url">Base URL</FieldLabel>
              <Input
                defaultValue={settings.baseUrl ?? ""}
                id="settings-base-url"
                name="baseUrl"
                placeholder="https://api.example.com/v1"
                type="url"
              />
            </Field>
          )}
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="settings-api-key">API key</FieldLabel>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Input
                autoComplete="new-password"
                className="flex-1"
                disabled={clearApiKey}
                id="settings-api-key"
                name="apiKey"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  settings.hasApiKey
                    ? settings.apiKeyMask || "Configured"
                    : "Not configured"
                }
                type="password"
                value={apiKey}
              />
              {settings.hasApiKey && (
                <Button
                  onClick={() => setClearApiKey((value) => !value)}
                  type="button"
                  variant={clearApiKey ? "secondary" : "outline"}
                >
                  {clearApiKey ? "Keep saved key" : "Clear saved key"}
                </Button>
              )}
            </div>
            <FieldDescription>
              {clearApiKey
                ? "The saved key will be cleared when you save."
                : "Leave blank to preserve the saved key."}
            </FieldDescription>
          </Field>
        </div>
      </section>

      <section aria-labelledby="runtime-settings" className="border-t pt-6">
        <h2 className="font-semibold text-base" id="runtime-settings">
          Runtime defaults
        </h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="settings-environment">Environment</FieldLabel>
            <select
              className={selectClass}
              id="settings-environment"
              name="environment"
              onChange={(event) =>
                setEnvironment(
                  event.target.value as SettingsPublic["environment"]
                )
              }
              value={environment}
            >
              <option value="local">Local</option>
              <option value="container">Container</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-image">Container image</FieldLabel>
            <Input
              defaultValue={settings.containerImage}
              id="settings-image"
              name="containerImage"
              required
              type="text"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-cpus">CPUs</FieldLabel>
            <Input
              defaultValue={settings.cpus}
              id="settings-cpus"
              max="16"
              min="0.1"
              name="cpus"
              required
              step="0.1"
              type="number"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-memory">Memory (MB)</FieldLabel>
            <Input
              defaultValue={settings.memoryMb}
              id="settings-memory"
              max="32768"
              min="128"
              name="memoryMb"
              required
              step="1"
              type="number"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-pids">PID limit</FieldLabel>
            <Input
              defaultValue={settings.pidsLimit}
              id="settings-pids"
              max="4096"
              min="16"
              name="pidsLimit"
              required
              step="1"
              type="number"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-concurrency">
              Max concurrency
            </FieldLabel>
            <Input
              defaultValue={settings.maxConcurrency}
              id="settings-concurrency"
              max="32"
              min="1"
              name="maxConcurrency"
              required
              step="1"
              type="number"
            />
          </Field>
        </div>
      </section>

      {mutation.error && (
        <p className="text-destructive-foreground text-sm" role="alert">
          {mutation.error.message}
        </p>
      )}
      {mutation.isSuccess && (
        <p className="text-muted-foreground text-sm" role="status">
          Settings saved.
        </p>
      )}
      <div className="flex justify-end border-t pt-5">
        <Button loading={mutation.isPending} type="submit">
          Save settings
        </Button>
      </div>
    </form>
  )
}

function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiRequest<SettingsPublic>("/settings"),
  })

  return (
    <div className="min-h-svh bg-muted/30">
      <ProductHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-7 sm:px-6 sm:py-9">
        <Button
          className="mb-5"
          render={<Link aria-label="Back to events" to="/" />}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft /> Events
        </Button>
        <h1 className="font-semibold text-2xl">Settings</h1>
        <p className="mt-1 mb-7 text-muted-foreground text-sm">
          Configure model and runtime defaults for new runs.
        </p>
        {settings.isPending && (
          <p className="py-16 text-center text-muted-foreground text-sm">
            Loading settings...
          </p>
        )}
        {settings.error && (
          <ErrorState error={settings.error} retry={() => settings.refetch()} />
        )}
        {settings.data && <SettingsForm settings={settings.data} />}
      </main>
    </div>
  )
}

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
      description: String(data.get("description")).trim(),
      startsAt: getOptionalDate(data.get("startsAt")),
      endsAt: getOptionalDate(data.get("endsAt")),
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
      <DialogPopup className="sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>{event ? "Edit event" : "Create event"}</DialogTitle>
          <DialogDescription>
            {event
              ? "Update the event details and schedule."
              : "Set up a workspace for challenges and runs."}
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="grid gap-5">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                defaultValue={event?.name}
                name="name"
                required
                type="text"
              />
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                defaultValue={event?.description}
                name="description"
                required
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>Starts at</FieldLabel>
                <Input
                  defaultValue={toLocalDateTime(event?.startsAt ?? null)}
                  name="startsAt"
                  type="datetime-local"
                />
              </Field>
              <Field>
                <FieldLabel>Ends at</FieldLabel>
                <Input
                  defaultValue={toLocalDateTime(event?.endsAt ?? null)}
                  name="endsAt"
                  type="datetime-local"
                />
              </Field>
            </div>
            {mutation.error && (
              <p className="text-destructive-foreground text-sm" role="alert">
                {mutation.error.message}
              </p>
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
      <AlertDialogPopup className="sm:rounded-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {event.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the event and its challenges.
          </AlertDialogDescription>
          {mutation.error && (
            <p className="text-destructive-foreground text-sm" role="alert">
              {mutation.error.message}
            </p>
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
    <Card className="min-w-0 rounded-lg before:rounded-[7px]">
      <CardHeader className="p-5 pb-3">
        <CardTitle className="min-w-0 pr-16 text-base leading-5">
          <Link className="hover:underline" to={`/events/${event.id}`}>
            {event.name}
          </Link>
        </CardTitle>
        <CardDescription className="line-clamp-2">
          {event.description || "No description"}
        </CardDescription>
        <CardAction className="gap-1">
          <IconTooltip label={`Edit ${event.name}`}>
            <EventDialog event={event} />
          </IconTooltip>
          <IconTooltip label={`Delete ${event.name}`}>
            <DeleteEventDialog event={event} />
          </IconTooltip>
        </CardAction>
      </CardHeader>
      <CardPanel className="grid grid-cols-2 gap-4 px-5 pt-1 pb-5 text-sm">
        <div>
          <p className="text-muted-foreground text-xs">Schedule</p>
          <p className="mt-1 truncate">{formatDate(event.startsAt)}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Challenges</p>
          <p className="mt-1 font-medium">{event.challengeCount}</p>
        </div>
      </CardPanel>
      <CardFooter className="border-t px-5 py-3">
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

function HomePage() {
  const events = useQuery({
    queryKey: eventKeys.all,
    queryFn: () => apiRequest<{ items: EventSummary[] }>("/events"),
  })

  return (
    <div className="min-h-svh bg-muted/30">
      <ProductHeader />
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-7 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-semibold text-2xl">Events</h1>
            <p className="mt-1 text-muted-foreground text-sm">
              Manage CTF workspaces, challenges, and run preparation.
            </p>
          </div>
          <EventDialog />
        </div>

        {events.isPending && (
          <p className="py-16 text-center text-muted-foreground text-sm">
            Loading events...
          </p>
        )}
        {events.error && (
          <ErrorState error={events.error} retry={() => events.refetch()} />
        )}
        {events.data?.items.length === 0 && (
          <Empty className="rounded-lg border bg-card">
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {events.data.items.map((event) => (
              <EventCard event={event} key={event.id} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

type ChallengeMutationResult = {
  challenge: Challenge
  uploadError: string | null
}

async function uploadAttachment(challengeId: string, file: File) {
  return apiRequest<Attachment>(
    `/challenges/${challengeId}/attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }
  )
}

function ChallengeDialog({
  eventId,
  challenge,
  onUploadError,
}: {
  eventId: string
  challenge?: Challenge
  onUploadError: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async ({
      input,
      file,
    }: {
      input: ChallengeInput
      file: File | null
    }): Promise<ChallengeMutationResult> => {
      const saved = await apiRequest<Challenge>(
        challenge
          ? `/challenges/${challenge.id}`
          : `/events/${eventId}/challenges`,
        jsonRequest(challenge ? "PATCH" : "POST", input)
      )

      if (!file) {
        return { challenge: saved, uploadError: null }
      }

      try {
        await uploadAttachment(saved.id, file)
        return { challenge: saved, uploadError: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed"
        return { challenge: saved, uploadError: message }
      }
    },
    onSuccess: async ({ challenge: saved, uploadError }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
      onUploadError(
        uploadError
          ? `${saved.name} was saved, but the attachment upload failed: ${uploadError}`
          : null
      )
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
    const points = String(data.get("points") ?? "").trim()
    const attachment = data.get("attachment")

    mutation.mutate({
      input: {
        name: String(data.get("name")).trim(),
        description: String(data.get("description")).trim(),
        category: String(data.get("category") ?? "").trim() || null,
        points: points ? Number(points) : null,
      },
      file:
        attachment instanceof File && attachment.size > 0 ? attachment : null,
    })
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        render={
          challenge ? (
            <Button
              aria-label={`Edit ${challenge.name}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          ) : (
            <Button type="button" />
          )
        }
      >
        {challenge ? (
          <Pencil />
        ) : (
          <>
            <Plus /> Add challenge
          </>
        )}
      </DialogTrigger>
      <DialogPopup className="sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>
            {challenge ? "Edit challenge" : "Create challenge"}
          </DialogTitle>
          <DialogDescription>
            Define the task details and optionally attach one file.
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="grid gap-5">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                defaultValue={challenge?.name}
                name="name"
                required
                type="text"
              />
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                defaultValue={challenge?.description}
                name="description"
                required
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>Category</FieldLabel>
                <Input
                  defaultValue={challenge?.category ?? ""}
                  name="category"
                  placeholder="Web, Crypto, Pwn..."
                  type="text"
                />
              </Field>
              <Field>
                <FieldLabel>Points</FieldLabel>
                <Input
                  defaultValue={challenge?.points ?? ""}
                  min="0"
                  name="points"
                  step="1"
                  type="number"
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Attachment</FieldLabel>
              <Input name="attachment" nativeInput type="file" />
              <FieldDescription>
                The file uploads after the challenge is saved.
              </FieldDescription>
            </Field>
            {mutation.error && (
              <p className="text-destructive-foreground text-sm" role="alert">
                {mutation.error.message}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              {challenge ? "Save changes" : "Create challenge"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function DeleteChallengeDialog({
  eventId,
  challenge,
}: {
  eventId: string
  challenge: Challenge
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/challenges/${challenge.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
    },
  })

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`Delete ${challenge.name}`}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Trash2 />
      </AlertDialogTrigger>
      <AlertDialogPopup className="sm:rounded-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {challenge.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the challenge and its attachments.
          </AlertDialogDescription>
          {mutation.error && (
            <p className="text-destructive-foreground text-sm" role="alert">
              {mutation.error.message}
            </p>
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
            Delete challenge
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

function AttachmentRow({ attachment }: { attachment: Attachment }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <FileArchive className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">
          {attachment.originalName}
        </p>
        <p className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
          {formatBytes(attachment.size)} - SHA-256 {attachment.sha256}
        </p>
      </div>
      <IconTooltip label={`Download ${attachment.originalName}`}>
        <Button
          aria-label={`Download ${attachment.originalName}`}
          render={<a href={attachment.downloadUrl} />}
          size="icon-sm"
          variant="ghost"
        >
          <Download />
        </Button>
      </IconTooltip>
    </div>
  )
}

function ChallengeCard({
  eventId,
  challenge,
  onUploadError,
}: {
  eventId: string
  challenge: Challenge
  onUploadError: (message: string | null) => void
}) {
  return (
    <Card className="min-w-0 rounded-lg before:rounded-[7px]">
      <CardHeader className="p-5 pb-4">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {challenge.category || "Uncategorized"}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {challenge.points === null
              ? "No points"
              : `${challenge.points} pts`}
          </span>
        </div>
        <CardTitle className="pr-16 text-base leading-5">
          {challenge.name}
        </CardTitle>
        <CardDescription className="line-clamp-3 whitespace-pre-line">
          {challenge.description || "No description"}
        </CardDescription>
        <CardAction className="gap-1">
          <IconTooltip label={`Start run for ${challenge.name}`}>
            <CreateRunDialog challenge={challenge} trigger={<Play />} />
          </IconTooltip>
          <IconTooltip label={`Edit ${challenge.name}`}>
            <ChallengeDialog
              challenge={challenge}
              eventId={eventId}
              onUploadError={onUploadError}
            />
          </IconTooltip>
          <IconTooltip label={`Delete ${challenge.name}`}>
            <DeleteChallengeDialog challenge={challenge} eventId={eventId} />
          </IconTooltip>
        </CardAction>
      </CardHeader>
      <CardPanel className="px-5 pt-0 pb-4">
        <div className="grid grid-cols-2 gap-4 border-t py-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Run state</p>
            <p className="mt-1 font-medium">Not started</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Runs</p>
            <p className="mt-1 font-medium">{challenge.runCount}</p>
          </div>
        </div>
        {challenge.attachments.length > 0 && (
          <section aria-label="Attachments">
            {challenge.attachments.map((attachment) => (
              <AttachmentRow attachment={attachment} key={attachment.id} />
            ))}
          </section>
        )}
      </CardPanel>
    </Card>
  )
}

function EventPage() {
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

  if (!eventId) {
    return null
  }

  return (
    <div className="min-h-svh bg-muted/30">
      <ProductHeader />
      <main className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
        <Button
          className="mb-5"
          render={<Link aria-label="Back to events" to="/" />}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft /> Events
        </Button>

        {eventQuery.isPending && (
          <p className="py-16 text-center text-muted-foreground text-sm">
            Loading event...
          </p>
        )}
        {eventQuery.error && (
          <ErrorState
            error={eventQuery.error}
            retry={() => eventQuery.refetch()}
          />
        )}
        {eventQuery.data && (
          <>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h1 className="truncate font-semibold text-2xl">
                    {eventQuery.data.event.name}
                  </h1>
                  <Badge variant="secondary">
                    {eventQuery.data.challenges.length} challenges
                  </Badge>
                </div>
                <p className="mt-2 max-w-3xl whitespace-pre-line text-muted-foreground text-sm">
                  {eventQuery.data.event.description || "No description"}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground text-xs">
                  <span>
                    Starts {formatDate(eventQuery.data.event.startsAt)}
                  </span>
                  <span>Ends {formatDate(eventQuery.data.event.endsAt)}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <IconTooltip label="Import unavailable: no platform adapter configured">
                  <Button
                    aria-label="Import unavailable: no platform adapter configured"
                    disabled
                    type="button"
                    variant="outline"
                  >
                    <Download /> Import
                  </Button>
                </IconTooltip>
                <ChallengeDialog
                  eventId={eventId}
                  onUploadError={setUploadError}
                />
              </div>
            </div>

            <Tabs
              className="mt-7"
              onValueChange={(value) =>
                navigate(
                  value === "run"
                    ? `/events/${eventId}/run`
                    : value === "statistics"
                      ? `/events/${eventId}/statistics`
                      : `/events/${eventId}`
                )
              }
              value={
                location.pathname === `/events/${eventId}/statistics`
                  ? "statistics"
                  : location.pathname.includes(`/events/${eventId}/run`)
                    ? "run"
                    : "overview"
              }
            >
              <TabsList
                className="w-full justify-start border-b"
                variant="underline"
              >
                <TabsTab value="overview">Overview</TabsTab>
                <TabsTab value="run">Run</TabsTab>
                <TabsTab value="statistics">Statistics</TabsTab>
              </TabsList>
              <TabsPanel className="pt-6" value="overview">
                {uploadError && (
                  <Alert className="mb-5 rounded-lg" variant="warning">
                    <TriangleAlert />
                    <AlertTitle>Attachment upload failed</AlertTitle>
                    <AlertDescription>{uploadError}</AlertDescription>
                  </Alert>
                )}
                {eventQuery.data.challenges.length === 0 ? (
                  <Empty className="rounded-lg border bg-card">
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
              <TabsPanel className="pt-6" value="statistics">
                <EventStatistics eventId={eventId} />
              </TabsPanel>
            </Tabs>
          </>
        )}
      </main>
    </div>
  )
}

const router = createBrowserRouter([
  { path: "/", Component: HomePage },
  { path: "/settings", Component: SettingsPage },
  { path: "/events/:eventId", Component: EventPage },
  { path: "/events/:eventId/run", Component: EventPage },
  { path: "/events/:eventId/runs/:runId", Component: EventPage },
  { path: "/events/:eventId/statistics", Component: EventPage },
])

export function App() {
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  )
}

export default App
