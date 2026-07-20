import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Link2, RefreshCw, Settings2, Unlink } from "lucide-react"
import { useEffect, useState } from "react"
import { Controller, useForm } from "react-hook-form"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CheckboxGroup } from "@/components/ui/checkbox-group"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
} from "@/components/ui/progress"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  apiRequest,
  type ChallengeSyncResult,
  type EventPlatform,
  type EventSummary,
  jsonRequest,
  type PlatformType,
  type RemoteChallengeSummary,
  type RemoteEvent,
} from "@/lib/api"
import { eventKeys } from "./event-shared"
import { syncChallengeStream } from "./platform-sync-stream"

const platformLabels: Record<PlatformType, string> = {
  ctfd: "CTFd",
  ret2shell: "ret2shell",
  a1ctf: "A1CTF",
}

const credentialLabels: Record<PlatformType, string> = {
  ctfd: "Access token",
  ret2shell: "Bearer token",
  a1ctf: "a1token cookie",
}

export function PlatformBinding({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const detach = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/events/${event.id}/platform`, { method: "DELETE" }),
    onSuccess: () => refreshEvent(queryClient, event.id),
  })

  if (!event.platform) return <ConnectPlatformDialog eventId={event.id} />

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{platformLabels[event.platform.type]}</Badge>
      <span className="max-w-56 truncate text-muted-foreground text-xs">
        {event.platform.baseUrl}
      </span>
      <ImportChallengesDialog eventId={event.id} />
      <ConnectPlatformDialog eventId={event.id} platform={event.platform} />
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              aria-label="Disconnect platform"
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <Unlink />
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect platform?</AlertDialogTitle>
            <AlertDialogDescription>
              Current challenge snapshots and attachments will be kept. A later
              connection to the same competition will update those challenges.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </AlertDialogClose>
            <Button
              loading={detach.isPending}
              onClick={() => detach.mutate()}
              type="button"
              variant="destructive"
            >
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {detach.error && (
        <span className="text-destructive text-xs">{detach.error.message}</span>
      )}
    </div>
  )
}

export function ImportChallengesDialog({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [log, setLog] = useState<ChallengeSyncResult["results"]>([])
  const challengeKey = ["events", eventId, "platform", "challenges"] as const
  const challenges = useQuery({
    enabled: open,
    queryKey: challengeKey,
    queryFn: () =>
      apiRequest<{ syncedAt: string; items: RemoteChallengeSummary[] }>(
        `/events/${eventId}/platform/challenges/discover`,
        { method: "POST" }
      ),
  })
  useEffect(() => {
    if (open && challenges.data) {
      setSelected(
        challenges.data.items
          .filter((challenge) => !challenge.imported)
          .map((challenge) => challenge.id)
      )
    }
  }, [challenges.data, open])
  const sync = useMutation({
    mutationFn: () => {
      setProgress({ completed: 0, total: selected.length })
      setLog([])
      return syncChallengeStream(
        eventId,
        selected,
        (item, completed, total) => {
          setProgress({ completed, total })
          setLog((current) => [...current, item])
        }
      )
    },
    onSuccess: async (result) => {
      await refreshEvent(queryClient, eventId)
      const failed = result.results
        .filter((item) => item.status === "failed")
        .map((item) => item.remoteId)
      if (failed.length === 0) {
        setOpen(false)
        return
      }
      setSelected(failed)
    },
  })
  const items = challenges.data?.items ?? []
  const failures = sync.data?.results.filter(
    (result) => result.status === "failed"
  )

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && sync.isPending) return
        setOpen(next)
        if (next) {
          sync.reset()
          setProgress({ completed: 0, total: 0 })
          setLog([])
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        <RefreshCw /> Import challenges
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Import challenges</DialogTitle>
          <DialogDescription>
            New challenges are selected automatically. Select imported entries
            to import them again; platform data overwrites local edits.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {challenges.isPending ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner /> Loading challenges...
            </div>
          ) : challenges.error ? (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>{challenges.error.message}</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-muted-foreground text-xs">
                  {selected.length} of {items.length} selected
                </span>
                <Button
                  disabled={sync.isPending}
                  onClick={() =>
                    setSelected(
                      selected.length === items.length
                        ? []
                        : items.map((challenge) => challenge.id)
                    )
                  }
                  type="button"
                  variant="ghost"
                >
                  {selected.length === items.length
                    ? "Clear all"
                    : "Select all"}
                </Button>
              </div>
              <CheckboxGroup
                aria-label="Remote challenges"
                className="max-h-80 w-full gap-0 overflow-y-auto border-y"
                disabled={sync.isPending}
                onValueChange={setSelected}
                value={selected}
              >
                {items.map((challenge) => (
                  <Label
                    className="flex w-full items-center gap-3 border-b px-2 py-3 last:border-b-0"
                    key={challenge.id}
                  >
                    <Checkbox value={challenge.id} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-sm">
                          {challenge.name}
                        </span>
                        {challenge.imported && (
                          <Badge size="sm" variant="secondary">
                            Imported
                          </Badge>
                        )}
                        {challenge.solved && (
                          <Badge size="sm" variant="success">
                            Solved
                          </Badge>
                        )}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {challenge.category ?? "Uncategorized"}
                        {challenge.points === null
                          ? ""
                          : ` · ${challenge.points} pts`}
                      </span>
                    </span>
                  </Label>
                ))}
              </CheckboxGroup>
              {items.length === 0 && (
                <p className="py-8 text-center text-muted-foreground text-sm">
                  No challenges are currently available.
                </p>
              )}
              {progress.total > 0 && (
                <div className="mt-4 grid gap-3" aria-live="polite">
                  <Progress value={(progress.completed / progress.total) * 100}>
                    <div className="flex items-center justify-between gap-3">
                      <ProgressLabel>Import progress</ProgressLabel>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {progress.completed} / {progress.total}
                      </span>
                    </div>
                    <ProgressTrack>
                      <ProgressIndicator />
                    </ProgressTrack>
                  </Progress>
                  <div
                    className="max-h-32 overflow-y-auto border bg-muted/30 p-2 font-mono text-xs"
                    role="log"
                  >
                    {log.map((entry) => (
                      <p className="py-0.5" key={entry.remoteId}>
                        [{entry.status.toUpperCase()}] {entry.remoteId}
                        {entry.error ? `: ${entry.error}` : ""}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {(sync.error || failures?.length) && (
                <Alert className="mt-3" variant="error">
                  <CircleAlert />
                  <AlertDescription>
                    {sync.error?.message ??
                      failures
                        ?.map(
                          (failure) =>
                            `${failure.remoteId}: ${failure.error ?? "Sync failed"}`
                        )
                        .join("; ")}
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            render={
              <Button disabled={sync.isPending} type="button" variant="ghost" />
            }
          >
            Cancel
          </DialogClose>
          <Button
            disabled={selected.length === 0}
            loading={sync.isPending}
            onClick={() => sync.mutate()}
            type="button"
          >
            Import {selected.length || ""}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function ConnectPlatformDialog({
  eventId,
  platform,
}: {
  eventId: string
  platform?: EventPlatform
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const form = useForm<{
    type: PlatformType
    baseUrl: string
    credential: string
    remoteEventId: string
  }>({
    defaultValues: {
      type: platform?.type ?? "ctfd",
      baseUrl: platform?.baseUrl ?? "",
      credential: platform?.credential ?? "",
      remoteEventId: platform?.remoteEventId ?? "",
    },
  })
  const type = form.watch("type")
  const baseUrl = form.watch("baseUrl")
  const credential = form.watch("credential")
  const remoteEventId = form.watch("remoteEventId")
  const discover = useMutation({
    mutationFn: () =>
      apiRequest<{ items: RemoteEvent[] }>(
        "/platform/events/discover",
        jsonRequest("POST", { type, baseUrl: baseUrl.trim(), credential })
      ),
    onSuccess: ({ items }) =>
      form.setValue("remoteEventId", items[0]?.id ?? ""),
  })
  const bind = useMutation({
    mutationFn: (values: {
      type: PlatformType
      baseUrl: string
      credential: string
      remoteEventId: string
    }) =>
      apiRequest<EventPlatform>(
        `/events/${eventId}/platform`,
        jsonRequest("PUT", {
          type: values.type,
          baseUrl: values.baseUrl.trim(),
          credential: values.credential,
          remoteEventId: values.type === "ctfd" ? "site" : values.remoteEventId,
        })
      ),
    onSuccess: async () => {
      await refreshEvent(queryClient, eventId)
      setOpen(false)
      form.reset({
        type: platform?.type ?? "ctfd",
        baseUrl: platform?.baseUrl ?? "",
        credential: platform?.credential ?? "",
        remoteEventId: platform?.remoteEventId ?? "",
      })
    },
  })
  const discoverData = discover.data
  const needsDiscovery = !platform && type !== "ctfd" && !discoverData

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          discover.reset()
          bind.reset()
          form.reset({
            type: platform?.type ?? "ctfd",
            baseUrl: platform?.baseUrl ?? "",
            credential: platform?.credential ?? "",
            remoteEventId: platform?.remoteEventId ?? "",
          })
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={platform ? "Update platform connection" : undefined}
            type="button"
            variant="outline"
          />
        }
      >
        {platform ? <Settings2 /> : <Link2 />}
        {!platform && "Connect platform"}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {platform ? "Update platform connection" : "Connect CTF platform"}
          </DialogTitle>
          <DialogDescription>
            Credentials are stored only for this event and are never exposed to
            agents.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={form.handleSubmit((values) => {
            if (needsDiscovery) discover.mutate()
            else bind.mutate(values)
          })}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>Platform</FieldLabel>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select
                    disabled={Boolean(platform)}
                    items={platformLabels}
                    onValueChange={(value) => {
                      field.onChange(value as PlatformType)
                      form.setValue("remoteEventId", "")
                      discover.reset()
                    }}
                    value={field.value}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {(Object.keys(platformLabels) as PlatformType[]).map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {platformLabels[value]}
                          </SelectItem>
                        )
                      )}
                    </SelectPopup>
                  </Select>
                )}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="platform-url">Platform URL</FieldLabel>
              <Controller
                control={form.control}
                name="baseUrl"
                render={({ field }) => (
                  <Input
                    disabled={Boolean(platform)}
                    id="platform-url"
                    onBlur={() => {
                      field.onBlur()
                      discover.reset()
                    }}
                    onChange={field.onChange}
                    required
                    type="url"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="platform-credential">
                {credentialLabels[type]}
              </FieldLabel>
              <Controller
                control={form.control}
                name="credential"
                render={({ field }) => (
                  <Input
                    autoComplete="off"
                    id="platform-credential"
                    onBlur={() => {
                      field.onBlur()
                      discover.reset()
                    }}
                    onChange={field.onChange}
                    required
                    type="text"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            {discoverData && type !== "ctfd" && (
              <Field>
                <FieldLabel>Competition</FieldLabel>
                <Controller
                  control={form.control}
                  name="remoteEventId"
                  render={({ field }) => (
                    <Select
                      items={Object.fromEntries(
                        discoverData.items.map((event) => [
                          event.id,
                          event.name,
                        ])
                      )}
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a competition" />
                      </SelectTrigger>
                      <SelectPopup>
                        {discoverData.items.map((event) => (
                          <SelectItem key={event.id} value={event.id}>
                            {event.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                  rules={{ required: true }}
                />
              </Field>
            )}
            {(discover.error || bind.error) && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>
                  {(discover.error ?? bind.error)?.message}
                </AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={
                !baseUrl.trim() ||
                !credential ||
                Boolean(discoverData && type !== "ctfd" && !remoteEventId)
              }
              loading={discover.isPending || bind.isPending}
              type="submit"
            >
              {needsDiscovery
                ? "Load competitions"
                : platform
                  ? "Update connection"
                  : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

async function refreshEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  eventId: string
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
    queryClient.invalidateQueries({ queryKey: eventKeys.all }),
    queryClient.invalidateQueries({ queryKey: ["runs", "event", eventId] }),
  ])
}
