import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  CircleDot,
  CircleDashed,
  EllipsisVertical,
  Paperclip,
  Play,
  Server,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"

import {
  type Challenge,
  challengesApi,
  keys,
  type AgentStatus,
  type SolveState,
} from "@/api"
import { IconTooltip } from "@/components/shell/product-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
  Card,
  CardAction,
  CardDescription,
  CardFrame,
  CardFrameFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { SpawnAgentDialog } from "@/features/runs"
import { agentStatusLabel, statusVariant } from "@/features/runs/agent-overview"
import { toast } from "@/lib/toast"

import { ChallengeDialog } from "./challenge-dialog"
import { ChallengeStatusDialog } from "./challenge-status-dialog"
import { overallSolved } from "./event-shared"

const SOLVE_BADGE_LABEL: Record<SolveState, string> = {
  solved: "已解决",
  partial: "部分解出",
  unsolved: "待解决",
}

function SolveBadge({ overall }: { overall: SolveState }) {
  const variant =
    overall === "solved"
      ? "success"
      : overall === "partial"
        ? "warning"
        : "secondary"
  return (
    <Badge size="sm" variant={variant}>
      {SOLVE_BADGE_LABEL[overall]}
    </Badge>
  )
}

function DeleteChallengeAlertDialog({
  eventId,
  challenge,
  open,
  onOpenChange,
}: {
  eventId: string
  challenge: Challenge
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      {open ? (
        <DeleteChallengeDialogContent
          challenge={challenge}
          eventId={eventId}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </AlertDialog>
  )
}

function DeleteChallengeDialogContent({
  eventId,
  challenge,
  onClose,
}: {
  eventId: string
  challenge: Challenge
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => challengesApi.deleteChallenge(challenge.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.events.detail(eventId),
        }),
        queryClient.invalidateQueries({ queryKey: keys.events.all }),
      ])
      toast.success("题目已删除")
      onClose()
    },
    onError: (error) => toast.error("删除题目失败", error.message),
  })

  return (
    <AlertDialogPopup>
      <AlertDialogHeader>
        <AlertDialogTitle>删除 {challenge.name}？</AlertDialogTitle>
        <AlertDialogDescription>
          这将永久删除该题目及其附件。
        </AlertDialogDescription>
        {mutation.error && (
          <Alert variant="error">
            <TriangleAlert />
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button type="button" variant="ghost" />}>
          取消
        </AlertDialogClose>
        <Button
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
          type="button"
          variant="destructive"
        >
          删除题目
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  )
}

/** Three-dot menu: modify solve state + (non-managed only) delete. */
function ChallengeActionsMenu({
  challenge,
  eventId,
  managed,
}: {
  challenge: Challenge
  eventId: string
  managed: boolean
}) {
  const [statusOpen, setStatusOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={`更多操作 ${challenge.name}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <EllipsisVertical />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            onClick={() => {
              setStatusOpen(true)
            }}
          >
            <CircleDot />
            修改状态
          </MenuItem>
          {!managed && (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  setDeleteOpen(true)
                }}
              >
                <Trash2 />
                删除题目
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
      {statusOpen ? (
        <ChallengeStatusDialog
          challenge={challenge}
          eventId={eventId}
          onClose={() => setStatusOpen(false)}
        />
      ) : null}
      {!managed && deleteOpen ? (
        <DeleteChallengeAlertDialog
          challenge={challenge}
          eventId={eventId}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
    </>
  )
}

export function ChallengeCard({
  eventId,
  challenge,
  managed = false,
  onUploadError,
}: {
  eventId: string
  challenge: Challenge
  managed?: boolean
  onUploadError: (message: string | null) => void
}) {
  return (
    <CardFrame
      className="h-full min-w-0 transition-colors hover:border-foreground/25"
      render={<article />}
    >
      <Card className="min-h-0 flex-1">
        <CardHeader className="grid-rows-[auto] gap-0 p-4 pb-1">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant="outline">
                {challenge.category || "未分类"}
              </Badge>
              <SolveBadge overall={overallSolved(challenge)} />
              {challenge.remoteId && !challenge.remoteAvailable && (
                <Badge size="sm" variant="warning">
                  远端不可用
                </Badge>
              )}
            </div>
            <CardTitle className="min-w-0 text-base leading-5">
              <h2 className="truncate">{challenge.name}</h2>
            </CardTitle>
          </div>
          <CardAction className="row-span-1 row-start-1 gap-0.5">
            <IconTooltip label={`查看并编辑 ${challenge.name}`}>
              <ChallengeDialog
                challenge={challenge}
                eventId={eventId}
                onUploadError={onUploadError}
              />
            </IconTooltip>
            <IconTooltip label={`为 ${challenge.name} 启动任务`}>
              <SpawnAgentDialog
                challenge={challenge}
                trigger={<Play />}
                triggerSize="icon-sm"
                triggerVariant="ghost"
              />
            </IconTooltip>
            <IconTooltip label={`更多操作 ${challenge.name}`}>
              <ChallengeActionsMenu
                challenge={challenge}
                eventId={eventId}
                managed={managed}
              />
            </IconTooltip>
          </CardAction>
        </CardHeader>
        <CardPanel className="px-4 pb-4">
          <CardDescription className="line-clamp-2 min-h-10 leading-5 whitespace-pre-line">
            {challenge.description || "无描述"}
          </CardDescription>
        </CardPanel>
      </Card>
      <CardFrameFooter className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          {challenge.points === null ? "无分值" : `${challenge.points} 分`}
        </span>
        {challenge.attachments.length > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Paperclip aria-hidden="true" className="size-3.5" />
            <span className="sr-only">附件：</span>
            {challenge.attachments.length}
          </span>
        )}
        {(challenge.remoteTargetCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Server aria-hidden="true" className="size-3.5" />
            <span className="sr-only">目标：</span>
            {challenge.remoteTargetCount}
          </span>
        )}
        {challenge.agentCount > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            {Object.entries(challenge.agentStatusCounts).map(
              ([status, count]) => {
                if (count <= 0) return null
                const runStatus = status as AgentStatus
                const Icon =
                  runStatus === "running"
                    ? Play
                    : runStatus === "idle"
                      ? CircleDashed
                      : Archive
                return (
                  <Badge
                    key={status}
                    size="sm"
                    variant={statusVariant(runStatus)}
                  >
                    {count}
                    <Icon className="size-3" />
                    <span className="sr-only">
                      {" "}
                      {agentStatusLabel(runStatus)}
                    </span>
                  </Badge>
                )
              }
            )}
          </span>
        )}
      </CardFrameFooter>
    </CardFrame>
  )
}
