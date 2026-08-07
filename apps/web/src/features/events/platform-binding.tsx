import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleCheck, Unlink } from "lucide-react"

import { type EventSummary, platformsApi } from "@/api"
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
import { toast } from "@/lib/toast"

import { ConnectPlatformDialog } from "./connect-platform-dialog"
import { platformLabels, refreshEvent } from "./platform-config"

export { ImportChallengesDialog } from "./import-challenges-dialog"

export function PlatformBinding({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const testConnection = useMutation({
    mutationFn: () => platformsApi.testBoundPlatform(event.id),
    onSuccess: () => {
      refreshEvent(queryClient, event.id)
      toast.success("平台连接正常")
    },
    onError: (error) => toast.error("平台连接失败", error.message),
  })
  const detach = useMutation({
    mutationFn: () => platformsApi.unbindPlatform(event.id),
    onSuccess: () => refreshEvent(queryClient, event.id),
  })

  if (!event.platform) return <ConnectPlatformDialog eventId={event.id} />

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{platformLabels[event.platform.type]}</Badge>
      <span className="max-w-56 truncate text-xs text-muted-foreground">
        {event.platform.baseUrl}
      </span>
      <Button
        loading={testConnection.isPending}
        onClick={() => testConnection.mutate()}
        type="button"
        variant="outline"
      >
        <CircleCheck /> 测试连接
      </Button>
      <ConnectPlatformDialog eventId={event.id} platform={event.platform} />
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              aria-label="断开平台"
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <Unlink />
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>断开平台？</AlertDialogTitle>
            <AlertDialogDescription>
              当前的题目快照和附件将被保留。之后连接到同一赛事时会更新这些题目。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </AlertDialogClose>
            <Button
              loading={detach.isPending}
              onClick={() => detach.mutate()}
              type="button"
              variant="destructive"
            >
              断开
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {detach.error && (
        <span className="text-xs text-destructive">{detach.error.message}</span>
      )}
      {testConnection.isSuccess && (
        <span className="text-xs text-success">连接成功</span>
      )}
      {testConnection.error && (
        <span className="text-xs text-destructive">
          {testConnection.error.message}
        </span>
      )}
    </div>
  )
}
