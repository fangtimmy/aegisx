import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Copy, Flag, Plus, Trash2 } from "lucide-react"
import { useState } from "react"

import { type Challenge, type ChallengeFlag, challengesApi, keys } from "@/api"
import { IconTooltip } from "@/components/shell/icon-tooltip"
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
import { Input } from "@/components/ui/input"
import { toast } from "@/lib/toast"

const FLAG_STATUS_LABEL: Record<ChallengeFlag["status"], string> = {
  pending: "待验证",
  accepted: "已验证",
  rejected: "已拒绝",
  error: "错误",
}

function copyFlag(value: string) {
  void navigator.clipboard.writeText(value).then(
    () => toast.success("已复制 flag"),
    () => toast.error("复制失败")
  )
}

/** One-to-many flag management: record manual candidates, remove any flag. */
export function FlagsSection({
  challenge,
  eventId,
}: {
  challenge: Challenge
  eventId: string
}) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState("")
  const addFlag = useMutation({
    mutationFn: (flag: string) =>
      challengesApi.addManualFlag(challenge.id, flag),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.events.detail(eventId),
      })
      setValue("")
      toast.success("已记录 flag")
    },
    onError: (error) => toast.error("添加 flag 失败", error.message),
  })
  const deleteFlag = useMutation({
    mutationFn: (flagId: string) =>
      challengesApi.deleteManualFlag(challenge.id, flagId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.events.detail(eventId),
      })
    },
    onError: (error) => toast.error("删除 flag 失败", error.message),
  })
  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    addFlag.mutate(trimmed)
  }
  return (
    <section aria-labelledby="challenge-flags" className="border-t px-6 py-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium" id="challenge-flags">
          Flag
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {challenge.flags.length}
        </span>
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // IME composition: Enter commits the composition, never records.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === "Enter") {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="输入 flag 字符串，回车记录"
          type="text"
          value={value}
        />
        <Button
          disabled={!value.trim()}
          loading={addFlag.isPending}
          onClick={submit}
          type="button"
          variant="outline"
        >
          <Plus /> 记录
        </Button>
      </div>
      {challenge.flags.length > 0 ? (
        <ul className="mt-3 border-y">
          {challenge.flags.map((flag) => (
            <FlagRow
              flag={flag}
              key={flag.id}
              onDelete={() => deleteFlag.mutate(flag.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          暂无 flag。记录的候选 flag 默认视为本地已验证。
        </p>
      )}
    </section>
  )
}

function FlagRow({
  flag,
  onDelete,
}: {
  flag: ChallengeFlag
  onDelete: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  return (
    <li className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <Flag className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs break-all">{flag.flag}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {FLAG_STATUS_LABEL[flag.status]}
          {flag.source === "manual"
            ? " · 手动"
            : flag.agentId
              ? " · 任务提交"
              : ""}
        </p>
      </div>
      <IconTooltip label="复制 flag">
        <Button
          aria-label="复制 flag"
          onClick={() => copyFlag(flag.flag)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Copy />
        </Button>
      </IconTooltip>
      <IconTooltip label="删除 flag">
        <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <AlertDialogTrigger
            render={
              <Button
                aria-label="删除 flag"
                size="icon-sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <Trash2 />
          </AlertDialogTrigger>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>删除该 flag？</AlertDialogTitle>
              <AlertDialogDescription>
                <span className="font-mono break-all">{flag.flag}</span>
                <br />
                删除后无法恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                render={<Button type="button" variant="ghost" />}
              >
                取消
              </AlertDialogClose>
              <Button
                onClick={() => {
                  onDelete()
                  setConfirmOpen(false)
                }}
                type="button"
                variant="destructive"
              >
                删除
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </IconTooltip>
    </li>
  )
}
