import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Link2, RefreshCw, Unlink } from "lucide-react"
import { useEffect, useState } from "react"
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  type EventSummary,
  jsonRequest,
  type PlatformType,
  type RemoteEvent,
} from "@/lib/api"
import { eventKeys } from "./shared"

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

  if (!event.platformType) return <ConnectPlatformDialog eventId={event.id} />

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{platformLabels[event.platformType]}</Badge>
      <span className="max-w-56 truncate text-muted-foreground text-xs">
        {event.platformBaseUrl}
      </span>
      <ImportChallengesDialog event={event} />
      <AlertDialog>
        <AlertDialogTrigger
          render={<Button size="icon-sm" type="button" variant="ghost" />}
        >
          <Unlink />
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect platform?</AlertDialogTitle>
            <AlertDialogDescription>
              Current challenge snapshots and attachments will be kept as manual
              event data.
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

type RemoteChallengeSummary = {
  id: string
  name: string
  category: string | null
  points: number | null
  solved: boolean
}

function ImportChallengesDialog({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const challenges = useQuery({
    enabled: open,
    queryKey: ["events", event.id, "platform", "challenges"],
    queryFn: () =>
      apiRequest<{ items: RemoteChallengeSummary[] }>(
        `/events/${event.id}/platform/challenges`
      ),
  })
  useEffect(() => {
    if (open && challenges.data) {
      setSelected(challenges.data.items.map((challenge) => challenge.id))
    }
  }, [challenges.data, open])
  const importChallenges = useMutation({
    mutationFn: () =>
      apiRequest(
        `/events/${event.id}/platform/import`,
        jsonRequest("POST", { remoteIds: selected })
      ),
    onSuccess: async () => {
      await refreshEvent(queryClient, event.id)
      setOpen(false)
    },
  })
  const items = challenges.data?.items ?? []

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) importChallenges.reset()
      }}
      open={open}
    >
      <DialogTrigger
        render={<Button size="sm" type="button" variant="outline" />}
      >
        <RefreshCw /> Import challenges
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Import challenges</DialogTitle>
          <DialogDescription>
            Select remote challenges to add or refresh in this event.
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
                  onClick={() =>
                    setSelected(
                      selected.length === items.length
                        ? []
                        : items.map((challenge) => challenge.id)
                    )
                  }
                  size="sm"
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
                      <span className="block truncate font-medium text-sm">
                        {challenge.name}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {challenge.category ?? "Uncategorized"}
                        {challenge.points === null
                          ? ""
                          : ` · ${challenge.points} pts`}
                        {challenge.solved ? " · Solved" : ""}
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
              {importChallenges.error && (
                <Alert className="mt-3" variant="error">
                  <CircleAlert />
                  <AlertDescription>
                    {importChallenges.error.message}
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={selected.length === 0}
            loading={importChallenges.isPending}
            onClick={() => importChallenges.mutate()}
            type="button"
          >
            Import {selected.length || ""}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function ConnectPlatformDialog({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<PlatformType>("ctfd")
  const [baseUrl, setBaseUrl] = useState("")
  const [credential, setCredential] = useState("")
  const [remoteEventId, setRemoteEventId] = useState("")
  const discover = useMutation({
    mutationFn: () =>
      apiRequest<{ items: RemoteEvent[] }>(
        `/events/${eventId}/platform/events`,
        jsonRequest("POST", { type, baseUrl: baseUrl.trim(), credential })
      ),
    onSuccess: ({ items }) => setRemoteEventId(items[0]?.id ?? ""),
  })
  const bind = useMutation({
    mutationFn: () =>
      apiRequest(
        `/events/${eventId}/platform/bind`,
        jsonRequest("POST", {
          type,
          baseUrl: baseUrl.trim(),
          credential,
          remoteEventId,
        })
      ),
    onSuccess: async () => {
      await refreshEvent(queryClient, eventId)
      setOpen(false)
    },
  })
  const eventItems = Object.fromEntries(
    (discover.data?.items ?? []).map((event) => [event.id, event.name])
  )

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          discover.reset()
          bind.reset()
          setRemoteEventId("")
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={<Button size="sm" type="button" variant="outline" />}
      >
        <Link2 /> Connect platform
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Connect CTF platform</DialogTitle>
          <DialogDescription>
            This event will mirror one remote competition.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(formEvent) => {
            formEvent.preventDefault()
            if (remoteEventId) bind.mutate()
            else discover.mutate()
          }}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>Platform</FieldLabel>
              <Select
                items={platformLabels}
                onValueChange={(value) => {
                  setType(value as PlatformType)
                  setRemoteEventId("")
                  discover.reset()
                }}
                value={type}
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
            </Field>
            <Field>
              <FieldLabel htmlFor="platform-url">Platform URL</FieldLabel>
              <Input
                id="platform-url"
                onChange={(input) => {
                  setBaseUrl(input.target.value)
                  setRemoteEventId("")
                  discover.reset()
                }}
                required
                type="url"
                value={baseUrl}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="platform-credential">
                {credentialLabels[type]}
              </FieldLabel>
              <Input
                autoComplete="new-password"
                id="platform-credential"
                onChange={(input) => {
                  setCredential(input.target.value)
                  setRemoteEventId("")
                  discover.reset()
                }}
                required
                type="password"
                value={credential}
              />
              <FieldDescription>
                Stored only for this event and never exposed to agents.
              </FieldDescription>
            </Field>
            {discover.data && (
              <Field>
                <FieldLabel>Competition</FieldLabel>
                <Select
                  items={eventItems}
                  onValueChange={(value) => setRemoteEventId(value ?? "")}
                  value={remoteEventId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a competition" />
                  </SelectTrigger>
                  <SelectPopup>
                    {discover.data.items.map((event) => (
                      <SelectItem key={event.id} value={event.id}>
                        {event.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
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
                Boolean(discover.data && !remoteEventId)
              }
              loading={discover.isPending || bind.isPending}
              type="submit"
            >
              {remoteEventId ? "Connect" : "Load competitions"}
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
