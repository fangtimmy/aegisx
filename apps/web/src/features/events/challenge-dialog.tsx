import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Download,
  FileArchive,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { useRef, useState } from "react"
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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { Textarea } from "@/components/ui/textarea"
import {
  type Attachment,
  apiRequest,
  type Challenge,
  type ChallengeInput,
  jsonRequest,
} from "@/lib/api"
import { eventKeys } from "./shared"

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

type ChallengeMutationResult = {
  challenge: Challenge
  uploadErrors: string[]
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
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const uploadInput = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) =>
      apiRequest<void>(`/attachments/${attachmentId}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
  })
  const removeTarget = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/challenges/${challenge?.id}/target`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
  })
  const mutation = useMutation({
    mutationFn: async ({
      input,
      files,
    }: {
      input: ChallengeInput
      files: File[]
    }): Promise<ChallengeMutationResult> => {
      const saved = await apiRequest<Challenge>(
        challenge
          ? `/challenges/${challenge.id}`
          : `/events/${eventId}/challenges`,
        jsonRequest(challenge ? "PATCH" : "POST", input)
      )

      const results = await Promise.allSettled(
        files.map((file) => uploadAttachment(saved.id, file))
      )
      return {
        challenge: saved,
        uploadErrors: results.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                `${files[index].name}: ${result.reason instanceof Error ? result.reason.message : "Upload failed"}`,
              ]
            : []
        ),
      }
    },
    onSuccess: async ({ challenge: saved, uploadErrors }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
      onUploadError(
        uploadErrors.length > 0
          ? `${saved.name} was saved, but some attachments failed: ${uploadErrors.join("; ")}`
          : null
      )
      setOpen(false)
    },
  })

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      setPendingFiles([])
      mutation.reset()
      removeAttachment.reset()
      removeTarget.reset()
    }
  }

  function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    const data = new FormData(formEvent.currentTarget)
    const points = String(data.get("points") ?? "").trim()
    const files = data
      .getAll("attachments")
      .filter((value): value is File => value instanceof File && value.size > 0)

    mutation.mutate({
      input: {
        name: String(data.get("name")).trim(),
        description: String(data.get("description")).trim(),
        category: String(data.get("category") ?? "").trim() || null,
        points: points ? Number(points) : null,
      },
      files,
    })
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        render={
          challenge ? (
            <Button
              aria-label={`View and edit ${challenge.name}`}
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
      <DialogPopup className="max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{challenge?.name ?? "Create challenge"}</DialogTitle>
          <DialogDescription>
            {challenge
              ? `${challenge.category || "Uncategorized"}${challenge.points === null ? "" : ` · ${challenge.points} pts`}`
              : "Define the task details and add its attachments."}
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel className="min-w-0 overflow-x-hidden p-0">
            <section
              aria-labelledby="challenge-details"
              className="grid gap-4 px-6 pb-6"
            >
              <h3 className="font-medium text-sm" id="challenge-details">
                Details
              </h3>
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
                  rows={6}
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
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
            </section>
            <section
              aria-labelledby="challenge-attachments"
              className="border-t px-6 py-5"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium text-sm" id="challenge-attachments">
                  Attachments
                </h3>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {challenge?.attachments.length ?? 0}
                  </span>
                  <Button
                    aria-label="Upload attachments"
                    onClick={() => uploadInput.current?.click()}
                    size="icon-sm"
                    title="Upload attachments"
                    type="button"
                    variant="outline"
                  >
                    <Upload />
                  </Button>
                  <input
                    className="sr-only"
                    multiple
                    name="attachments"
                    onChange={(event) =>
                      setPendingFiles(Array.from(event.target.files ?? []))
                    }
                    ref={uploadInput}
                    tabIndex={-1}
                    type="file"
                  />
                </div>
              </div>
              {challenge && challenge.attachments.length > 0 && (
                <div className="mt-3 border-y">
                  {challenge.attachments.map((attachment) => (
                    <AttachmentRow
                      attachment={attachment}
                      deleting={
                        removeAttachment.isPending &&
                        removeAttachment.variables === attachment.id
                      }
                      key={attachment.id}
                      onDelete={() => removeAttachment.mutate(attachment.id)}
                    />
                  ))}
                </div>
              )}
              {pendingFiles.length > 0 && (
                <p className="mt-3 truncate text-muted-foreground text-xs">
                  {pendingFiles.length} selected:{" "}
                  {pendingFiles.map((file) => file.name).join(", ")}
                </p>
              )}
            </section>
            {challenge?.remoteTarget && !challenge.remoteTargetIgnored && (
              <section
                aria-labelledby="challenge-target"
                className="border-t px-6 py-5"
              >
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="font-medium text-sm" id="challenge-target">
                      Platform target
                    </h3>
                    <p className="mt-1 text-muted-foreground text-xs">
                      Imported targets cannot be edited. Removing this target
                      disables platform target tools for future Runs.
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button type="button" variant="destructive-outline" />
                      }
                    >
                      <Trash2 /> Remove target
                    </AlertDialogTrigger>
                    <AlertDialogPopup>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Remove platform target?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          The target must be stopped first. AegisX will keep it
                          ignored after future platform syncs.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogClose
                          render={<Button type="button" variant="ghost" />}
                        >
                          Cancel
                        </AlertDialogClose>
                        <Button
                          loading={removeTarget.isPending}
                          onClick={() => removeTarget.mutate()}
                          type="button"
                          variant="destructive"
                        >
                          Remove target
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogPopup>
                  </AlertDialog>
                </div>
                {challenge.targets.length > 0 && (
                  <div className="mt-3 border-y">
                    {challenge.targets.map((target) => (
                      <div
                        className="flex min-w-0 items-center justify-between gap-3 border-b py-2 last:border-b-0"
                        key={`${target.name}:${target.services.join(",")}`}
                      >
                        <span className="min-w-0 truncate text-sm">
                          {target.name}
                        </span>
                        <span className="min-w-0 break-all text-right text-muted-foreground text-xs">
                          {target.services.join(", ") || "No exposed services"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
            {(removeAttachment.error || removeTarget.error) && (
              <Alert className="mx-6 mb-4 w-auto" variant="error">
                <TriangleAlert />
                <AlertDescription className="break-words">
                  {(removeAttachment.error ?? removeTarget.error)?.message}
                </AlertDescription>
              </Alert>
            )}
            {mutation.error && (
              <Alert className="mx-6 mb-4 w-auto" variant="error">
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

function AttachmentRow({
  attachment,
  deleting = false,
  onDelete,
}: {
  attachment: Attachment
  deleting?: boolean
  onDelete?: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <FileArchive className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">
          {attachment.originalName}
        </p>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {formatBytes(attachment.size)}
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
      {onDelete && (
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                aria-label={`Delete ${attachment.originalName}`}
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
              <AlertDialogTitle>
                Delete {attachment.originalName}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Platform attachments will return the next time this challenge is
                synchronized.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                render={<Button type="button" variant="ghost" />}
              >
                Cancel
              </AlertDialogClose>
              <Button
                loading={deleting}
                onClick={onDelete}
                type="button"
                variant="destructive"
              >
                Delete attachment
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  )
}
