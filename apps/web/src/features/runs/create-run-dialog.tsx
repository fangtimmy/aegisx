import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, CircleAlert, Monitor, Play, Plus } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, type ButtonProps } from "@/components/ui/button"
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
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type {
  Challenge,
  ProviderConnection,
  RunPublic,
  SettingsPublic,
} from "@/lib/api"
import { apiRequest, jsonRequest } from "@/lib/api"

export function CreateRunDialog({
  challenges,
  challenge,
  trigger,
  triggerLabel,
  triggerSize,
  triggerVariant,
  onCreated,
}: {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  trigger?: ReactNode
  triggerLabel?: string
  triggerSize?: ButtonProps["size"]
  triggerVariant?: ButtonProps["variant"]
  onCreated?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [environment, setEnvironment] = useState<"local" | "container">("local")
  const [modelId, setModelId] = useState("")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const settings = useQuery({
    enabled: open,
    queryKey: ["settings"],
    queryFn: () => apiRequest<SettingsPublic>("/settings"),
  })
  const providers = useQuery({
    enabled: open,
    queryKey: ["providers"],
    queryFn: () => apiRequest<{ items: ProviderConnection[] }>("/providers"),
  })
  const mutation = useMutation({
    mutationFn: ({
      challengeId,
      modelId,
      environment,
      image,
    }: {
      challengeId: string
      modelId: string
      environment: "local" | "container"
      image?: string
    }) =>
      apiRequest<RunPublic>(
        `/challenges/${challengeId}/runs`,
        jsonRequest("POST", { modelId, environment, image })
      ),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({
        queryKey: ["runs", "event", run.eventId],
      })
      setOpen(false)
      onCreated?.()
      navigate(`/events/${run.eventId}/runs/${run.id}`)
    },
  })

  useEffect(() => {
    if (open && settings.data) setEnvironment(settings.data.environment)
  }, [open, settings.data])

  const availableModels = (providers.data?.items ?? []).flatMap((provider) =>
    provider.enabled && provider.apiKey
      ? provider.models
          .filter((model) => model.enabled)
          .map((model) => ({ ...model, provider }))
      : []
  )

  useEffect(() => {
    if (!open || !settings.data || modelId) return
    const defaultModel = availableModels.find(
      (model) => model.id === settings.data.defaultModelId
    )
    setModelId(defaultModel?.id ?? availableModels[0]?.id ?? "")
  }, [availableModels, modelId, open, settings.data])

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      challengeId: challenge?.id ?? String(data.get("challengeId")),
      modelId,
      environment,
      image:
        environment === "container"
          ? String(data.get("image")).trim()
          : undefined,
    })
  }

  const available = challenge ? [challenge] : (challenges ?? [])
  const challengeItems = Object.fromEntries(
    available.map((item) => [item.id, item.name])
  )
  const modelItems = Object.fromEntries(
    availableModels.map((model) => [
      model.id,
      `${model.provider.label} / ${model.label}`,
    ])
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          mutation.reset()
          if (settings.data) setEnvironment(settings.data.environment)
          setModelId("")
        }
      }}
    >
      <DialogTrigger
        aria-label={
          trigger
            ? (triggerLabel ??
              (challenge ? `Start run for ${challenge.name}` : "Start run"))
            : undefined
        }
        render={
          <Button
            disabled={available.length === 0}
            size={trigger ? (triggerSize ?? "icon-xs") : undefined}
            type="button"
            variant={trigger ? triggerVariant : undefined}
          />
        }
      >
        {trigger ?? (
          <>
            <Plus /> Start run
          </>
        )}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Start run</DialogTitle>
          <DialogDescription>
            {challenge
              ? `Configure a run for ${challenge.name}.`
              : "Choose a challenge and model for this run."}
          </DialogDescription>
        </DialogHeader>
        {(settings.isPending || providers.isPending) && (
          <DialogPanel>
            <div
              className="flex items-center gap-2 text-muted-foreground text-sm"
              role="status"
            >
              <Spinner aria-hidden="true" />
              Loading defaults...
            </div>
          </DialogPanel>
        )}
        {(settings.error || providers.error) && (
          <DialogPanel>
            <Alert variant="error">
              <CircleAlert />
              <AlertTitle>Unable to load run configuration</AlertTitle>
              <AlertDescription>
                {(settings.error ?? providers.error)?.message}
              </AlertDescription>
              <Button
                onClick={() => {
                  settings.refetch()
                  providers.refetch()
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </Alert>
          </DialogPanel>
        )}
        {settings.data && providers.data && (
          <form
            className="contents"
            key={settings.data.updatedAt}
            onSubmit={submit}
          >
            <DialogPanel className="grid gap-4">
              {!challenge && (
                <Field name="challengeId">
                  <FieldLabel>Challenge</FieldLabel>
                  <Select
                    defaultValue={available[0]?.id}
                    items={challengeItems}
                    name="challengeId"
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a challenge" />
                    </SelectTrigger>
                    <SelectPopup>
                      {available.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              )}
              <Field name="modelId">
                <FieldLabel>Model</FieldLabel>
                <Select
                  items={modelItems}
                  name="modelId"
                  required
                  onValueChange={(value) => setModelId(value ?? "")}
                  value={modelId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No enabled models" />
                  </SelectTrigger>
                  <SelectPopup>
                    {(providers.data?.items ?? []).map((provider) => {
                      const models = availableModels.filter(
                        (model) => model.provider.id === provider.id
                      )
                      if (models.length === 0) return null
                      return (
                        <SelectGroup key={provider.id}>
                          <SelectGroupLabel>{provider.label}</SelectGroupLabel>
                          {models.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )
                    })}
                  </SelectPopup>
                </Select>
              </Field>
              <Field name="environment">
                <FieldLabel>Environment</FieldLabel>
                <Select
                  items={{ container: "Container", local: "Local" }}
                  name="environment"
                  onValueChange={(value) =>
                    setEnvironment(value as "local" | "container")
                  }
                  value={environment}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="local">Local</SelectItem>
                    <SelectItem value="container">Container</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
              {environment === "container" && (
                <Field>
                  <FieldLabel htmlFor="run-image">Container image</FieldLabel>
                  <Input
                    defaultValue={settings.data.containerImage}
                    id="run-image"
                    name="image"
                    required
                    type="text"
                  />
                </Field>
              )}
              {environment === "local" ? (
                <Alert variant="warning">
                  <Monitor />
                  <AlertTitle>Local execution is not sandboxed</AlertTitle>
                  <AlertDescription>
                    The agent can access the local runtime and challenge
                    workspace. Review the challenge before starting.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <Box />
                  <AlertTitle>Isolated container</AlertTitle>
                  <AlertDescription>
                    The agent runs in an isolated container with its workspace
                    at /workspace.
                  </AlertDescription>
                </Alert>
              )}
              {mutation.error && (
                <Alert variant="error">
                  <CircleAlert />
                  <AlertDescription>{mutation.error.message}</AlertDescription>
                </Alert>
              )}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>
                Cancel
              </DialogClose>
              <Button
                disabled={!modelId}
                loading={mutation.isPending}
                type="submit"
              >
                <Play /> Start run
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  )
}
