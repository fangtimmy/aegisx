import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"
import { type ChallengeSyncResult, keys, platformsApi } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Label } from "@/components/ui/label"
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
} from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/lib/toast"
import { refreshEvent } from "./platform-config"
import { syncChallengeStream } from "./platform-sync-stream"

export function ImportChallengesDialog({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [log, setLog] = useState<ChallengeSyncResult["results"]>([])
  const challengeKey = [
    ...keys.events.detail(eventId),
    "platform",
    "challenges",
  ] as const
  const challenges = useQuery({
    enabled: open,
    queryKey: challengeKey,
    queryFn: () => platformsApi.discoverChallenges(eventId),
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
      const synced = result.results.length - failed.length
      if (failed.length === 0) {
        toast.success(`Imported ${synced} challenge${synced === 1 ? "" : "s"}`)
        setOpen(false)
        return
      }
      toast.warning(
        `Imported ${synced}, ${failed.length} failed`,
        "Retrying failed items"
      )
      setSelected(failed)
    },
    onError: (error) => toast.error("Challenge sync failed", error.message),
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
                <div aria-live="polite" className="mt-4 grid gap-3">
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
