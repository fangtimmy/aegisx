import { useMutation } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useCallback, useState, useSyncExternalStore } from "react"

import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"

type QueueRow = { role: "steering" | "followUp"; index: number; text: string }

/** Editable list of queued steer / follow-up messages above the input. Commits
 * clear + re-queue via `setQueue`; the server reconciles through queue.updated. */
export function SteerQueue({
  agentId,
  setQueue,
  stream,
}: {
  agentId: string
  setQueue: (
    agentId: string,
    body: { steering: string[]; followUp: string[] }
  ) => Promise<unknown>
  stream: ConversationStore
}) {
  const subscribe = useCallback(
    (listener: () => void) => stream.subscribe(agentId, listener),
    [stream, agentId]
  )
  const queue = useSyncExternalStore(
    subscribe,
    () => stream.getQueue(agentId),
    () => stream.getQueue(agentId)
  )
  const [edit, setEdit] = useState<QueueRow | null>(null)
  const put = useMutation({
    mutationFn: (body: { steering: string[]; followUp: string[] }) =>
      setQueue(agentId, body),
    onError: (error) => toast.error("更新队列失败", error.message),
  })

  const rows: QueueRow[] = [
    ...(queue?.steering ?? []).map((text, index) => ({
      role: "steering" as const,
      index,
      text,
    })),
    ...(queue?.followUp ?? []).map((text, index) => ({
      role: "followUp" as const,
      index,
      text,
    })),
  ]
  if (rows.length === 0) return null

  const replace = (
    role: "steering" | "followUp",
    index: number,
    text: string
  ) => {
    const base = {
      steering: [...(queue?.steering ?? [])],
      followUp: [...(queue?.followUp ?? [])],
    }
    base[role][index] = text
    put.mutate(base)
    setEdit(null)
  }
  const remove = (role: "steering" | "followUp", index: number) => {
    const base = {
      steering: [...(queue?.steering ?? [])],
      followUp: [...(queue?.followUp ?? [])],
    }
    base[role].splice(index, 1)
    put.mutate(base)
    setEdit(null)
  }

  return (
    <div className="rounded-lg border bg-popover/40 p-2 shadow-xs">
      <p className="mb-1 px-1 text-xs font-medium text-muted-foreground">
        队列
      </p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row, index) => {
          const editing = edit?.role === row.role && edit?.index === row.index
          return (
            <li
              className="flex items-center gap-1.5"
              key={`${row.role}:${row.index}`}
            >
              <span className="w-4 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {index + 1}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
                  row.role === "steering"
                    ? "bg-info/15 text-info"
                    : "bg-secondary text-secondary-foreground"
                )}
              >
                {row.role === "steering" ? "引导" : "追问"}
              </span>
              {editing ? (
                <input
                  className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
                  onBlur={(e) => replace(row.role, row.index, e.target.value)}
                  onChange={(e) => setEdit({ ...row, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      replace(row.role, row.index, edit.text)
                    } else if (e.key === "Escape") {
                      e.preventDefault()
                      setEdit(null)
                    }
                  }}
                  ref={(el) => el?.focus()}
                  value={edit?.text ?? ""}
                />
              ) : (
                <Button
                  className="min-w-0 flex-1 justify-start truncate px-2 font-mono text-xs text-muted-foreground hover:bg-secondary"
                  onClick={() => setEdit(row)}
                  size="sm"
                  title="点击编辑"
                  variant="ghost"
                >
                  {row.text}
                </Button>
              )}
              <Button
                aria-label="从队列移除"
                onClick={() => remove(row.role, row.index)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
