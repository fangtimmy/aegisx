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
      toast.success("Platform connection OK")
    },
    onError: (error) =>
      toast.error("Platform connection failed", error.message),
  })
  const detach = useMutation({
    mutationFn: () => platformsApi.unbindPlatform(event.id),
    onSuccess: () => refreshEvent(queryClient, event.id),
  })

  if (!event.platform) return <ConnectPlatformDialog eventId={event.id} />

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{platformLabels[event.platform.type]}</Badge>
      <span className="max-w-56 truncate text-muted-foreground text-xs">
        {event.platform.baseUrl}
      </span>
      <Button
        loading={testConnection.isPending}
        onClick={() => testConnection.mutate()}
        type="button"
        variant="outline"
      >
        <CircleCheck /> Test connection
      </Button>
      <ConnectPlatformDialog eventId={event.id} platform={event.platform} />
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              aria-label="Disconnect platform"
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
            <AlertDialogTitle>Disconnect platform?</AlertDialogTitle>
            <AlertDialogDescription>
              Current challenge snapshots and attachments will be kept. A later
              connection to the same competition will update those challenges.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </AlertDialogClose>
            <Button
              loading={detach.isPending}
              onClick={() => detach.mutate()}
              type="button"
              variant="destructive"
            >
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {detach.error && (
        <span className="text-destructive text-xs">{detach.error.message}</span>
      )}
      {testConnection.isSuccess && (
        <span className="text-success text-xs">Connection successful</span>
      )}
      {testConnection.error && (
        <span className="text-destructive text-xs">
          {testConnection.error.message}
        </span>
      )}
    </div>
  )
}
