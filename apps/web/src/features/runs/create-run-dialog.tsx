import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, CircleAlert, Monitor, Play, Plus } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Controller, useForm } from "react-hook-form"
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
  ThinkingLevel,
} from "@/lib/api"
import { apiRequest, jsonRequest } from "@/lib/api"
import { eventKeys } from "../events/event-shared"

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
}
const offThinkingLevels: ThinkingLevel[] = ["off"]

type RunFormValues = {
  challengeId: string
  modelId: string
  thinkingLevel: ThinkingLevel
  environment: "local" | "container"
  image: string
}

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
    mutationFn: (values: RunFormValues) =>
      apiRequest<RunPublic>(
        `/challenges/${challenge?.id ?? values.challengeId}/runs`,
        jsonRequest("POST", {
          modelId: values.modelId,
          environment: values.environment,
          image:
            values.environment === "container"
              ? values.image.trim()
              : undefined,
          thinkingLevel: values.thinkingLevel,
        })
      ),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({
        queryKey: ["runs", "event", run.eventId],
      })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: eventKeys.detail(run.eventId),
        }),
        queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      ])
      setOpen(false)
      onCreated?.()
      navigate(`/events/${run.eventId}/runs/${run.id}`)
    },
  })

  const availableModels = (providers.data?.items ?? []).flatMap((provider) =>
    provider.enabled && provider.apiKey
      ? provider.models
          .filter((model) => model.enabled)
          .map((model) => ({ ...model, provider }))
      : []
  )
  const form = useForm<RunFormValues>({
    defaultValues: {
      challengeId: challenge?.id ?? challenges?.[0]?.id ?? "",
      modelId: "",
      thinkingLevel: "off",
      environment: "local",
      image: "",
    },
  })
  const environment = form.watch("environment")
  const modelId = form.watch("modelId")
  const selectedModel = availableModels.find((model) => model.id === modelId)
  const supportedThinkingLevels =
    selectedModel?.thinkingLevels ?? offThinkingLevels
  const supportedThinkingLevelsKey = supportedThinkingLevels.join(",")
  const firstSupportedThinkingLevel = supportedThinkingLevels[0] ?? "off"
  const thinkingLevel = form.watch("thinkingLevel")
  const isThinkingLevelSupported = supportedThinkingLevelsKey
    .split(",")
    .includes(thinkingLevel)
  const initialModelId = settings.data?.defaultModelId
    ? (availableModels.find(
        (model) => model.id === settings.data?.defaultModelId
      )?.id ??
      availableModels[0]?.id ??
      "")
    : (availableModels[0]?.id ?? "")

  useEffect(() => {
    if (open && settings.data) {
      form.reset({
        challengeId: challenge?.id ?? challenges?.[0]?.id ?? "",
        modelId: initialModelId,
        thinkingLevel: settings.data.defaultThinkingLevel,
        environment: settings.data.environment,
        image: settings.data.containerImage,
      })
    }
    // ponytail: availableModels derived from providers query; reset only on open/settings change
  }, [
    open,
    settings.data,
    challenges?.[0]?.id,
    form.reset,
    challenge?.id,
    initialModelId,
  ])

  useEffect(() => {
    if (!isThinkingLevelSupported) {
      form.setValue("thinkingLevel", firstSupportedThinkingLevel)
    }
  }, [isThinkingLevelSupported, firstSupportedThinkingLevel, form.setValue])

  const available = challenge ? [challenge] : (challenges ?? [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          mutation.reset()
          form.reset()
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
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          >
            <DialogPanel className="grid gap-4">
              {!challenge && (
                <Field>
                  <FieldLabel>Challenge</FieldLabel>
                  <Controller
                    control={form.control}
                    name="challengeId"
                    render={({ field }) => (
                      <Select
                        items={Object.fromEntries(
                          available.map((item) => [item.id, item.name])
                        )}
                        onValueChange={field.onChange}
                        value={field.value}
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
                    )}
                    rules={{ required: true }}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel>Model</FieldLabel>
                <Controller
                  control={form.control}
                  name="modelId"
                  render={({ field }) => (
                    <Select
                      items={Object.fromEntries(
                        availableModels.map((model) => [
                          model.id,
                          `${model.provider.label} / ${model.label}`,
                        ])
                      )}
                      onValueChange={field.onChange}
                      value={field.value}
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
                              <SelectGroupLabel>
                                {provider.label}
                              </SelectGroupLabel>
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
                  )}
                  rules={{ required: true }}
                />
              </Field>
              <Field>
                <FieldLabel>Reasoning</FieldLabel>
                <Controller
                  control={form.control}
                  name="thinkingLevel"
                  render={({ field }) => (
                    <Select
                      items={Object.fromEntries(
                        supportedThinkingLevels.map((level) => [
                          level,
                          thinkingLevelLabels[level],
                        ])
                      )}
                      onValueChange={(value) =>
                        field.onChange(value as ThinkingLevel)
                      }
                      value={field.value}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {supportedThinkingLevels.map((level) => (
                          <SelectItem key={level} value={level}>
                            {thinkingLevelLabels[level]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                />
              </Field>
              <Field>
                <FieldLabel>Environment</FieldLabel>
                <Controller
                  control={form.control}
                  name="environment"
                  render={({ field }) => (
                    <Select
                      items={{ container: "Container", local: "Local" }}
                      onValueChange={(value) =>
                        field.onChange(value as "local" | "container")
                      }
                      value={field.value}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="local">Local</SelectItem>
                        <SelectItem value="container">Container</SelectItem>
                      </SelectPopup>
                    </Select>
                  )}
                />
              </Field>
              {environment === "container" && (
                <Field>
                  <FieldLabel htmlFor="run-image">Container image</FieldLabel>
                  <Controller
                    control={form.control}
                    name="image"
                    render={({ field }) => (
                      <Input
                        id="run-image"
                        onBlur={field.onBlur}
                        onChange={field.onChange}
                        required
                        type="text"
                        value={field.value}
                      />
                    )}
                    rules={{ required: true }}
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
