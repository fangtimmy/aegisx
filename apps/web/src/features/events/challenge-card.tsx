import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Paperclip, Play, Server, Trash2, TriangleAlert } from "lucide-react"
import { IconTooltip } from "@/components/product-header"
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
import { apiRequest, type Challenge } from "@/lib/api"
import { ChallengeDialog } from "./challenge-dialog"
import { eventKeys } from "./shared"

function DeleteChallengeDialog({
  eventId,
  challenge,
}: {
  eventId: string
  challenge: Challenge
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/challenges/${challenge.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
    },
  })

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`Delete ${challenge.name}`}
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
          <AlertDialogTitle>Delete {challenge.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the challenge and its attachments.
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
            Cancel
          </AlertDialogClose>
          <Button
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            type="button"
            variant="destructive"
          >
            Delete challenge
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
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
                {challenge.category || "Uncategorized"}
              </Badge>
              <Badge
                size="sm"
                variant={
                  challenge.status === "solved" ? "success" : "secondary"
                }
              >
                {challenge.status === "solved" ? "Solved" : "Open"}
              </Badge>
              {challenge.remoteId && !challenge.remoteAvailable && (
                <Badge size="sm" variant="warning">
                  Remote unavailable
                </Badge>
              )}
            </div>
            <CardTitle className="min-w-0 text-base leading-5">
              <h2 className="truncate">{challenge.name}</h2>
            </CardTitle>
          </div>
          <CardAction className="row-span-1 row-start-1 gap-0.5">
            <IconTooltip label={`View and edit ${challenge.name}`}>
              <ChallengeDialog
                challenge={challenge}
                eventId={eventId}
                onUploadError={onUploadError}
              />
            </IconTooltip>
            <IconTooltip label={`Start run for ${challenge.name}`}>
              <CreateRunDialog
                challenge={challenge}
                trigger={<Play />}
                triggerSize="icon-sm"
                triggerVariant="ghost"
              />
            </IconTooltip>
            {!managed && (
              <IconTooltip label={`Delete ${challenge.name}`}>
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
            {challenge.description || "No description"}
          </CardDescription>
        </CardPanel>
      </Card>
      <CardFrameFooter className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-muted-foreground text-xs">
        <span className="font-medium text-foreground tabular-nums">
          {challenge.points === null ? "No points" : `${challenge.points} pts`}
        </span>
        {challenge.attachments.length > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Paperclip aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Attachments:</span>
            {challenge.attachments.length}
          </span>
        )}
        {(challenge.remoteTargetCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Server aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Targets:</span>
            {challenge.remoteTargetCount}
          </span>
        )}
        <span className="ml-auto tabular-nums">
          {challenge.runCount} {challenge.runCount === 1 ? "run" : "runs"}
        </span>
      </CardFrameFooter>
    </CardFrame>
  )
}
