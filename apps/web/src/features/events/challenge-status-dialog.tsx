import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"

import {
  type Challenge,
  type ChallengeFlag,
  challengesApi,
  keys,
  type SolveState,
} from "@/api"
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
import { toast } from "@/lib/toast"

import { overallSolved } from "./event-shared"

const SOLVE_LABEL: Record<SolveState, string> = {
  solved: "已解决",
  partial: "部分解出",
  unsolved: "未解决",
}

function solveVariant(state: SolveState) {
  if (state === "solved") return "success" as const
  if (state === "partial") return "warning" as const
  return "secondary" as const
}

const FLAG_STATUS_LABEL: Record<ChallengeFlag["status"], string> = {
  pending: "待验证",
  accepted: "已验证",
  rejected: "已拒绝",
  error: "错误",
}

function flagStatusVariant(status: ChallengeFlag["status"]) {
  if (status === "accepted") return "success" as const
  if (status === "pending") return "secondary" as const
  if (status === "error") return "error" as const
  return "outline" as const
}

const ASSIGN_OPTIONS: { value: SolveState; label: string }[] = [
  { value: "solved", label: "已解决" },
  { value: "partial", label: "部分解出" },
  { value: "unsolved", label: "未解决" },
]

export function ChallengeStatusDialog({
  challenge,
  eventId,
  onClose,
}: {
  challenge: Challenge
  eventId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) })

  const refresh = useMutation({
    mutationFn: () => challengesApi.refreshChallengeRemote(challenge.id),
    onSuccess: async () => {
      await invalidate()
      toast.success("已同步远程状态")
    },
    onError: (error) => toast.error("同步远程状态失败", error.message),
  })

  const assign = useMutation({
    mutationFn: (state: SolveState) =>
      challengesApi.setChallengeSolved(challenge.id, state),
    onSuccess: async () => {
      await invalidate()
      toast.success("已更新手动状态")
    },
    onError: (error) => toast.error("更新状态失败", error.message),
  })

  const overall = overallSolved(challenge)
  const hasRemote = Boolean(challenge.remoteId)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{challenge.name} · 已解状态</DialogTitle>
          <DialogDescription>
            综合「已解决 / 部分解出 / 未解决」。手动指派优先于远端与本地推导。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-w-0 p-0">
          <section className="grid gap-3 px-6 pt-6 pb-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">综合状态</h3>
              <Badge size="sm" variant={solveVariant(overall)}>
                {SOLVE_LABEL[overall]}
              </Badge>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-sm">
              {(
                [
                  ["本地", challenge.solved.local],
                  ["远程", challenge.solved.remote],
                  ["手动", challenge.solved.manual],
                ] as Array<[string, SolveState]>
              ).map(([label, state]) => (
                <div
                  className="flex flex-col items-start gap-1 rounded-md border p-2"
                  key={label}
                >
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd>
                    <Badge size="sm" variant={solveVariant(state)}>
                      {SOLVE_LABEL[state]}
                    </Badge>
                  </dd>
                </div>
              ))}
            </dl>
            {hasRemote && (
              <Button
                loading={refresh.isPending}
                onClick={() => refresh.mutate()}
                type="button"
                variant="outline"
              >
                <RefreshCw />
                同步远程状态
              </Button>
            )}
            {!hasRemote && (
              <p className="text-xs text-muted-foreground">
                本题未绑定平台，远程状态不可用。
              </p>
            )}
          </section>
          <section className="grid gap-3 border-t px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">手动指派</h3>
              <span className="text-xs text-muted-foreground">
                覆盖自动判定（设为「未解决」即清除手动标记）
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {ASSIGN_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  loading={
                    assign.isPending && assign.variables === option.value
                  }
                  onClick={() => assign.mutate(option.value)}
                  type="button"
                  variant={
                    challenge.solved.manual === option.value
                      ? "default"
                      : "outline"
                  }
                >
                  {option.label}
                </Button>
              ))}
            </div>
            {refresh.error && (
              <p className="text-xs text-destructive">
                {refresh.error.message}
              </p>
            )}
            {assign.error && (
              <p className="text-xs text-destructive">{assign.error.message}</p>
            )}
          </section>
          {challenge.flags.length > 0 && (
            <section className="grid gap-2 border-t px-6 py-5">
              <h3 className="text-sm font-medium">
                已记录 flag（{challenge.flags.length}）
              </h3>
              <ul className="grid gap-1.5">
                {challenge.flags.map((flag) => (
                  <li
                    className="flex min-w-0 items-center justify-between gap-2 border-b py-1.5 last:border-b-0"
                    key={flag.id}
                  >
                    <span className="min-w-0 truncate font-mono text-xs break-all">
                      {flag.flag}
                    </span>
                    <Badge size="sm" variant={flagStatusVariant(flag.status)}>
                      {FLAG_STATUS_LABEL[flag.status]}
                      {flag.source === "manual" ? " · 手动" : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            关闭
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
