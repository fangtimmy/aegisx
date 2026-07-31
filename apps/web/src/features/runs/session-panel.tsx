import { useQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { useState } from "react"
import { keys, runsApi } from "@/api"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { formatTime } from "@/lib/format"

export function SessionPanel({
  runId,
  enabled,
  running,
}: {
  runId: string
  enabled: boolean
  running: boolean
}) {
  const [selected, setSelected] = useState<string>()
  // Bump to force the iframe to refetch (the server caches the exported HTML,
  // so this only re-reads the cached file — useful after a re-export).
  const [nonce, setNonce] = useState(0)

  const sessions = useQuery({
    enabled: enabled && !running,
    queryKey: keys.runs.sessions(runId),
    queryFn: () => runsApi.listRunSessions(runId),
  })

  if (running) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
        Run is in progress. The full session replay is available after it ends.
      </div>
    )
  }
  if (sessions.isPending) {
    return (
      <div
        className="flex h-full items-center gap-2 p-6 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" /> Loading sessions...
      </div>
    )
  }
  if (sessions.error) {
    return (
      <p className="p-6 text-destructive-foreground text-sm" role="alert">
        {sessions.error.message}
      </p>
    )
  }

  const items = sessions.data?.items ?? []
  if (items.length === 0) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyTitle>No session recorded</EmptyTitle>
          <EmptyDescription>
            Session replay appears here once pi has recorded a session for this
            run.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const current = selected ?? items[0]?.id ?? ""
  return (
    <div className="flex h-full min-h-0 flex-col px-6 py-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-medium text-sm">Session replay</h3>
        {items.length > 1 && (
          <select
            aria-label="Select session"
            className="h-7 max-w-xs truncate rounded border bg-background px-2 text-xs"
            onChange={(e) => {
              setSelected(e.target.value)
              setNonce((n) => n + 1)
            }}
            value={current}
          >
            {items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.messageCount} msgs · {formatTime(s.modifiedAt)}
              </option>
            ))}
          </select>
        )}
        <Button
          aria-label="Reload replay"
          className="h-7 w-7 p-0"
          onClick={() => setNonce((n) => n + 1)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw />
        </Button>
      </div>
      <iframe
        className="min-h-0 flex-1 rounded border"
        key={`${current}-${nonce}`}
        src={`/api/runs/${runId}/sessions/${encodeURIComponent(current)}`}
        title="Session replay"
      />
    </div>
  )
}
