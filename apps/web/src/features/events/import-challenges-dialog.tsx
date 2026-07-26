import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  type ChallengeSyncItem,
  type ChallengeSyncProgress,
  keys,
  platformsApi,
} from "@/api"
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
import { cn } from "@/lib/utils"
import { refreshEvent } from "./platform-config"
import { syncChallengeStream } from "./platform-sync-stream"

type ImportLogEntry = {
  key: string
  level: "info" | "success" | "error"
  text: string
}

function challengeTitle(entry: { name?: string; remoteId: string }) {
  return entry.name?.trim() || entry.remoteId
}

function progressLogText(progress: ChallengeSyncProgress): string | null {
  const subject = challengeTitle(progress)
  if (progress.phase === "fetching") {
    return `${subject}: fetching challenge metadata`
  }
  if (progress.phase === "attachment" && progress.attachment) {
    return `${subject}: downloading ${progress.attachment.filename} (${progress.attachment.index}/${progress.attachment.total})`
  }
  return null
}

function itemLogLines(item: ChallengeSyncItem): ImportLogEntry[] {
  const subject = challengeTitle(item)
  if (item.status === "failed") {
    return [
      {
        key: `item-${item.remoteId}-failed`,
        level: "error",
        text: `${subject}: failed${item.error ? ` — ${item.error}` : ""}`,
      },
    ]
  }
  return [
    {
      key: `item-${item.remoteId}`,
      level: "success",
      text: `${subject}: imported challenge`,
    },
  ]
}

export function ImportChallengesDialog({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [log, setLog] = useState<ImportLogEntry[]>([])
  const [results, setResults] = useState<ChallengeSyncItem[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const logSeq = useRef(0)
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
  const appendLog = (entries: ImportLogEntry[]) => {
    setLog((current) => {
      const next = [...current, ...entries]
      queueMicrotask(() => {
        const node = logRef.current
        if (node) node.scrollTop = node.scrollHeight
      })
      return next
    })
  }
  const sync = useMutation({
    mutationFn: () => {
      setProgress({ completed: 0, total: selected.length })
      setLog([])
      setResults([])
      logSeq.current = 0
      return syncChallengeStream(eventId, selected, (event) => {
        if (event.type === "progress") {
          const text = progressLogText(event.progress)
          if (!text) return
          appendLog([
            {
              key: `progress-${++logSeq.current}`,
              level: "info",
              text,
            },
          ])
          return
        }
        setProgress({ completed: event.completed, total: event.total })
        setResults((current) => [...current, event.item])
        appendLog(itemLogLines(event.item))
      })
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
  const failures = results.filter((result) => result.status === "failed")

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && sync.isPending) return
        setOpen(next)
        if (next) {
          sync.reset()
          setProgress({ completed: 0, total: 0 })
          setLog([])
          setResults([])
          logSeq.current = 0
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
                    className="h-48 overflow-y-auto border bg-muted/30 p-2 font-mono text-xs"
                    ref={logRef}
                    role="log"
                  >
                    {log.length === 0 ? (
                      <p className="text-muted-foreground">
                        Waiting for import events...
                      </p>
                    ) : (
                      log.map((entry) => (
                        <p
                          className={cn(
                            "py-0.5 break-words whitespace-pre-wrap",
                            entry.level === "error" && "text-destructive",
                            entry.level === "success" && "text-foreground",
                            entry.level === "info" && "text-muted-foreground"
                          )}
                          key={entry.key}
                        >
                          {entry.text}
                        </p>
                      ))
                    )}
                  </div>
                </div>
              )}
              {(sync.error || failures.length > 0) && (
                <Alert className="mt-3" variant="error">
                  <CircleAlert />
                  <AlertDescription>
                    {sync.error?.message ??
                      failures
                        .map(
                          (failure) =>
                            `${challengeTitle(failure)}: ${failure.error ?? "Sync failed"}`
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
