import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  CircleSlash,
  Cloud,
  HardDrive,
  Paperclip,
  Play,
  Server,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { useState } from "react"
import { type Challenge, challengesApi, keys, type RunStatus } from "@/api"
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
  AlertDialogTrigger,
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
import { CreateRunDialog } from "@/features/runs"
import { statusVariant } from "@/features/runs/run-overview"
import { toast } from "@/lib/toast"
import { ChallengeDialog } from "./challenge-dialog"
import { isChallengeSolved } from "./event-shared"

function DeleteChallengeDialog({
  eventId,
  challenge,
}: {
  eventId: string
  challenge: Challenge
}) {
  const [open, setOpen] = useState(false)

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`删除 ${challenge.name}`}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Trash2 />
      </AlertDialogTrigger>
      {open ? (
        <DeleteChallengeDialogContent challenge={challenge} eventId={eventId} />
      ) : null}
    </AlertDialog>
  )
}

function DeleteChallengeDialogContent({
  eventId,
  challenge,
}: {
  eventId: string
  challenge: Challenge
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
    <CardFrame className="h-full min-w-0" render={<article />}>
      <Card className="min-h-0 flex-1">
        <CardHeader className="grid-rows-[auto] gap-0 p-4 pb-1">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant="outline">
                {challenge.category || "未分类"}
              </Badge>
              {isChallengeSolved(challenge) ? (
                <Badge size="sm" variant="success">
                  已解决
                  <Cloud
                    aria-label={
                      challenge.remoteSolved ? "远端已解决" : "远端未解决"
                    }
                    className={
                      challenge.remoteSolved
                        ? "size-3 opacity-100"
                        : "size-3 opacity-35"
                    }
                  />
                  <HardDrive
                    aria-label={
                      challenge.status === "solved"
                        ? "本地已解决"
                        : "本地未解决"
                    }
                    className={
                      challenge.status === "solved"
                        ? "size-3 opacity-100"
                        : "size-3 opacity-35"
                    }
                  />
                </Badge>
              ) : (
                <Badge size="sm" variant="secondary">
                  待解决
                </Badge>
              )}
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
              <CreateRunDialog
                challenge={challenge}
                trigger={<Play />}
                triggerSize="icon-sm"
                triggerVariant="ghost"
              />
            </IconTooltip>
            {!managed && (
              <IconTooltip label={`删除 ${challenge.name}`}>
                <DeleteChallengeDialog
                  challenge={challenge}
                  eventId={eventId}
                />
              </IconTooltip>
            )}
          </CardAction>
        </CardHeader>
        <CardPanel className="px-4 pb-4">
          <CardDescription className="line-clamp-2 min-h-10 whitespace-pre-line leading-5">
            {challenge.description || "无描述"}
          </CardDescription>
        </CardPanel>
      </Card>
      <CardFrameFooter className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-muted-foreground text-xs">
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
        {challenge.runCount > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            {Object.entries(challenge.runStatusCounts).map(([status, count]) =>
              count > 0 ? (
                <Badge
                  key={status}
                  size="sm"
                  variant={statusVariant(status as RunStatus)}
                >
                  {count}
                  {status === "completed" && <Check className="size-3" />}
                  {status === "failed" && <X className="size-3" />}
                  {status === "stopped" && <CircleSlash className="size-3" />}
                  {status === "running" && <Play className="size-3" />}
                  <span className="sr-only"> {status}</span>
                </Badge>
              ) : null
            )}
          </span>
        )}
      </CardFrameFooter>
    </CardFrame>
  )
}
