import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"

import { keys, type QueueItem, schedulerApi } from "@/api"
import { ListRow } from "@/components/list-row"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"

/**
 * Task-queue editor (overview Runs tab). Pending items can be
 * reordered (↑/↓), edited (prompt / timeout) and removed; running items are
 * read-only — the server rejects edits/removal, surfaced as an error toast.
 */
export function QueueList({
  eventId,
  items,
  onOpenAgent,
}: {
  eventId: string
  items: QueueItem[]
  onOpenAgent: (agentId: string) => void
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<QueueItem | null>(null)
  const [removing, setRemoving] = useState<QueueItem | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: keys.scheduler.queue(eventId),
    })
    void queryClient.invalidateQueries({ queryKey: keys.agents.fleet(eventId) })
  }

  const removeMutation = useMutation({
    mutationFn: (itemId: string) =>
      schedulerApi.removeQueueItem(eventId, itemId),
    onSuccess: () => {
      toast.success("已从队列移除")
      invalidate()
    },
    onError: (error) => toast.error("移除失败", error.message),
  })
  const reorderMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      schedulerApi.reorderQueue(eventId, itemIds),
    onSuccess: invalidate,
    onError: (error) => toast.error("排序失败", error.message),
  })

  const pending = items.filter((item) => item.status === "pending")

  const move = (item: QueueItem, direction: -1 | 1) => {
    const index = pending.findIndex((candidate) => candidate.id === item.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= pending.length) return
    const next = [...pending]
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderMutation.mutate(next.map((candidate) => candidate.id))
  }

  return (
    <div className="flex flex-col">
      {items.map((item) => {
        const editable = item.status === "pending"
        return (
          <div
            className="group flex min-w-0 items-center gap-2 border-b px-3 py-2 last:border-b-0"
            key={item.id}
          >
            <ListRow
              className="w-auto min-w-0 flex-1 items-center gap-2.5 rounded-none p-0"
              onClick={() => {
                if (item.agentId) onOpenAgent(item.agentId)
              }}
            >
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                #{item.ord}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {item.challengeName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.source === "scheduler" ? "调度者" : ""}
                  {item.error ? (
                    <span className="text-destructive"> · {item.error}</span>
                  ) : null}
                </span>
              </span>
              {item.status === "running" ? (
                <Badge size="sm" variant="info" className="gap-1">
                  <LoaderCircle className="size-3 animate-spin" /> 运行中
                </Badge>
              ) : item.status === "failed" ? (
                <Badge size="sm" variant="destructive">
                  失败
                </Badge>
              ) : (
                <Badge size="sm" variant="secondary">
                  排队中
                </Badge>
              )}
            </ListRow>
            {editable ? (
              <span className="flex shrink-0 items-center gap-0.5">
                <Button
                  aria-label="上移"
                  disabled={reorderMutation.isPending}
                  onClick={() => move(item, -1)}
                  size="icon-xs"
                  title="上移"
                  type="button"
                  variant="ghost"
                >
                  <ArrowUp />
                </Button>
                <Button
                  aria-label="下移"
                  disabled={reorderMutation.isPending}
                  onClick={() => move(item, 1)}
                  size="icon-xs"
                  title="下移"
                  type="button"
                  variant="ghost"
                >
                  <ArrowDown />
                </Button>
                <Button
                  aria-label="编辑队列项"
                  onClick={() => setEditing(item)}
                  size="icon-xs"
                  title="编辑提示词 / 超时"
                  type="button"
                  variant="ghost"
                >
                  <Pencil />
                </Button>
                <Button
                  aria-label="移除队列项"
                  onClick={() => setRemoving(item)}
                  size="icon-xs"
                  title="移除"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                </Button>
              </span>
            ) : null}
          </div>
        )
      })}
      {pending.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {pending.length} 项排队中
          </p>
          <ClearQueueButton eventId={eventId} onCleared={invalidate} />
        </div>
      )}
      {editing && (
        <EditQueueItemDialog
          eventId={eventId}
          item={editing}
          onChanged={invalidate}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <AlertDialog onOpenChange={(open) => !open && setRemoving(null)} open>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                移除 {removing.challengeName} 的队列项？
              </AlertDialogTitle>
              <AlertDialogDescription>
                该任务将从队列中移除（运行中的任务无法移除）。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                render={<Button type="button" variant="ghost" />}
              >
                取消
              </AlertDialogClose>
              <Button
                loading={removeMutation.isPending}
                onClick={() => {
                  removeMutation.mutate(removing.id)
                  setRemoving(null)
                }}
                type="button"
                variant="destructive"
              >
                移除
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  )
}

function ClearQueueButton({
  eventId,
  onCleared,
}: {
  eventId: string
  onCleared: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const mutation = useMutation({
    mutationFn: () => schedulerApi.clearQueue(eventId),
    onSuccess: () => {
      toast.success("队列已清空")
      onCleared()
    },
    onError: (error) => toast.error("清空失败", error.message),
  })
  return (
    <AlertDialog
      onOpenChange={(open) => !open && setConfirming(false)}
      open={confirming}
    >
      <Button
        className="px-1 text-xs text-muted-foreground hover:text-destructive"
        onClick={() => setConfirming(true)}
        size="xs"
        variant="link"
      >
        清空排队
      </Button>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>清空排队任务？</AlertDialogTitle>
          <AlertDialogDescription>
            移除所有排队中（未运行）的队列项。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="ghost" />}>
            取消
          </AlertDialogClose>
          <Button
            loading={mutation.isPending}
            onClick={() => {
              mutation.mutate()
              setConfirming(false)
            }}
            type="button"
            variant="destructive"
          >
            清空
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

function EditQueueItemDialog({
  eventId,
  item,
  onChanged,
  onClose,
}: {
  eventId: string
  item: QueueItem
  onChanged: () => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState(item.prompt)
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    item.timeoutMs ? Math.round(item.timeoutMs / 60_000) : 60
  )
  const mutation = useMutation({
    mutationFn: () =>
      schedulerApi.updateQueueItem(eventId, item.id, {
        prompt,
        timeoutMs: Math.max(1, Math.round(timeoutMinutes)) * 60_000,
      }),
    onSuccess: () => {
      toast.success("队列项已更新")
      onChanged()
      onClose()
    },
    onError: (error) => toast.error("更新失败", error.message),
  })
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>编辑队列项</DialogTitle>
          <DialogDescription>
            {item.challengeName}（仅排队中可编辑）
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="queue-prompt">首轮提示词</FieldLabel>
              <Textarea
                id="queue-prompt"
                onChange={(event) => setPrompt(event.target.value)}
                value={prompt}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="queue-timeout">超时（分钟）</FieldLabel>
              <NumberField
                id="queue-timeout"
                min={1}
                onValueChange={(value) => {
                  if (typeof value === "number") setTimeoutMinutes(value)
                }}
                value={timeoutMinutes}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
            {mutation.error && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <TriangleAlert className="size-3.5" />
                {mutation.error.message}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
