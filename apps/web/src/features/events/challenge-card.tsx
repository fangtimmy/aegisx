import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Download,
  FileArchive,
  Pencil,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"
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
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { Textarea } from "@/components/ui/textarea"
import { CreateRunDialog } from "@/features/runs"
import {
  type Attachment,
  apiRequest,
  type Challenge,
  type ChallengeInput,
  jsonRequest,
} from "@/lib/api"
import { eventKeys } from "./shared"

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

type ChallengeMutationResult = {
  challenge: Challenge
  uploadError: string | null
}

async function uploadAttachment(challengeId: string, file: File) {
  return apiRequest<Attachment>(
    `/challenges/${challengeId}/attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }
  )
}

export function ChallengeDialog({
  eventId,
  challenge,
  onUploadError,
}: {
  eventId: string
  challenge?: Challenge
  onUploadError: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async ({
      input,
      file,
    }: {
      input: ChallengeInput
      file: File | null
    }): Promise<ChallengeMutationResult> => {
      const saved = await apiRequest<Challenge>(
        challenge
          ? `/challenges/${challenge.id}`
          : `/events/${eventId}/challenges`,
        jsonRequest(challenge ? "PATCH" : "POST", input)
      )

      if (!file) {
        return { challenge: saved, uploadError: null }
      }

      try {
        await uploadAttachment(saved.id, file)
        return { challenge: saved, uploadError: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed"
        return { challenge: saved, uploadError: message }
      }
    },
    onSuccess: async ({ challenge: saved, uploadError }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
      onUploadError(
        uploadError
          ? `${saved.name} was saved, but the attachment upload failed: ${uploadError}`
          : null
      )
      setOpen(false)
    },
  })

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      mutation.reset()
    }
  }

  function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    const data = new FormData(formEvent.currentTarget)
    const points = String(data.get("points") ?? "").trim()
    const attachment = data.get("attachment")

    mutation.mutate({
      input: {
        name: String(data.get("name")).trim(),
        description: String(data.get("description")).trim(),
        category: String(data.get("category") ?? "").trim() || null,
        points: points ? Number(points) : null,
      },
      file:
        attachment instanceof File && attachment.size > 0 ? attachment : null,
    })
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        render={
          challenge ? (
            <Button
              aria-label={`Edit ${challenge.name}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          ) : (
            <Button type="button" />
          )
        }
      >
        {challenge ? (
          <Pencil />
        ) : (
          <>
            <Plus /> Add challenge
          </>
        )}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {challenge ? "Edit challenge" : "Create challenge"}
          </DialogTitle>
          <DialogDescription>
            Define the task details and optionally attach one file.
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="grid gap-5">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                defaultValue={challenge?.name}
                name="name"
                required
                type="text"
              />
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                defaultValue={challenge?.description}
                name="description"
                required
              />
            </Field>
            <div className="grid grid-cols-2 gap-5">
              <Field>
                <FieldLabel>Category</FieldLabel>
                <Input
                  defaultValue={challenge?.category ?? ""}
                  name="category"
                  placeholder="Web, Crypto, Pwn..."
                  type="text"
                />
              </Field>
              <Field name="points">
                <FieldLabel>Points</FieldLabel>
                <NumberField
                  defaultValue={challenge?.points ?? undefined}
                  min={0}
                  name="points"
                  step={1}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement />
                    <NumberFieldInput />
                    <NumberFieldIncrement />
                  </NumberFieldGroup>
                </NumberField>
              </Field>
            </div>
            <Field name="attachment">
              <FieldLabel>Attachment</FieldLabel>
              <Input
                aria-label="Attachment"
                name="attachment"
                nativeInput
                type="file"
              />
              <FieldDescription>
                The file uploads after the challenge is saved.
              </FieldDescription>
            </Field>
            {mutation.error && (
              <Alert variant="error">
                <TriangleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              {challenge ? "Save changes" : "Create challenge"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

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

function AttachmentRow({ attachment }: { attachment: Attachment }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <FileArchive className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">
          {attachment.originalName}
        </p>
        <p className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
          {formatBytes(attachment.size)} - SHA-256 {attachment.sha256}
        </p>
      </div>
      <IconTooltip label={`Download ${attachment.originalName}`}>
        <Button
          aria-label={`Download ${attachment.originalName}`}
          render={<a href={attachment.downloadUrl} />}
          size="icon-sm"
          variant="ghost"
        >
          <Download />
        </Button>
      </IconTooltip>
    </div>
  )
}

export function ChallengeCard({
  eventId,
  challenge,
  onUploadError,
}: {
  eventId: string
  challenge: Challenge
  onUploadError: (message: string | null) => void
}) {
  return (
    <Card className="min-w-0" render={<article />}>
      <CardHeader>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {challenge.category || "Uncategorized"}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {challenge.points === null
              ? "No points"
              : `${challenge.points} pts`}
          </span>
        </div>
        <CardTitle className="pr-16 text-base leading-5">
          <h2>{challenge.name}</h2>
        </CardTitle>
        <CardDescription className="line-clamp-3 whitespace-pre-line">
          {challenge.description || "No description"}
        </CardDescription>
        <CardAction className="gap-1">
          <IconTooltip label={`Start run for ${challenge.name}`}>
            <CreateRunDialog challenge={challenge} trigger={<Play />} />
          </IconTooltip>
          <IconTooltip label={`Edit ${challenge.name}`}>
            <ChallengeDialog
              challenge={challenge}
              eventId={eventId}
              onUploadError={onUploadError}
            />
          </IconTooltip>
          <IconTooltip label={`Delete ${challenge.name}`}>
            <DeleteChallengeDialog challenge={challenge} eventId={eventId} />
          </IconTooltip>
        </CardAction>
      </CardHeader>
      <CardPanel>
        <div className="grid grid-cols-2 gap-4 border-t py-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Run state</p>
            <p className="mt-1 font-medium">Not started</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Runs</p>
            <p className="mt-1 font-medium">{challenge.runCount}</p>
          </div>
        </div>
        {challenge.attachments.length > 0 && (
          <section aria-label="Attachments">
            {challenge.attachments.map((attachment) => (
              <AttachmentRow attachment={attachment} key={attachment.id} />
            ))}
          </section>
        )}
      </CardPanel>
    </Card>
  )
}
