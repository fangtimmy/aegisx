import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, CircleAlert, Play, Plus } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { useNavigate } from "react-router"
import {
  type Challenge,
  keys,
  providersApi,
  runsApi,
  settingsApi,
  type ThinkingLevel,
} from "@/api"
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
  image: string
}

type CreateRunDialogProps = {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  trigger?: ReactNode
  triggerLabel?: string
  triggerSize?: ButtonProps["size"]
  triggerVariant?: ButtonProps["variant"]
  onCreated?: () => void
}

export function CreateRunDialog({
  challenges,
  challenge,
  trigger,
  triggerLabel,
  triggerSize,
  triggerVariant,
  onCreated,
}: CreateRunDialogProps) {
  const [open, setOpen] = useState(false)
  const available = challenge ? [challenge] : (challenges ?? [])

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={
          trigger
            ? (triggerLabel ??
              (challenge ? `为 ${challenge.name} 启动任务` : "启动任务"))
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
            <Plus /> 启动任务
          </>
        )}
      </DialogTrigger>
      {open ? (
        <CreateRunDialogContent
          challenge={challenge}
          challenges={challenges}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  )
}

function CreateRunDialogContent({
  challenges,
  challenge,
  onCreated,
  onClose,
}: {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  onCreated?: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })
  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })
  const mutation = useMutation({
    mutationFn: (values: RunFormValues) =>
      runsApi.createRun(challenge?.id ?? values.challengeId, {
        modelId: values.modelId,
        image: values.image.trim(),
        thinkingLevel: values.thinkingLevel,
      }),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.runs.byEvent(run.eventId),
        }),
        queryClient.invalidateQueries({
          queryKey: keys.events.detail(run.eventId),
        }),
        queryClient.invalidateQueries({ queryKey: keys.events.all }),
      ])
      onClose()
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
      image: "",
    },
  })
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
  const defaults = settings.data?.settings
  const initialModelId = defaults?.["agent.defaultModelId"]
    ? (availableModels.find(
        (model) => model.id === defaults["agent.defaultModelId"]
      )?.id ??
      availableModels[0]?.id ??
      "")
    : (availableModels[0]?.id ?? "")

  useEffect(() => {
    if (defaults) {
      form.reset({
        challengeId: challenge?.id ?? challenges?.[0]?.id ?? "",
        modelId: initialModelId,
        thinkingLevel: defaults["agent.defaultThinkingLevel"],
        image: defaults["container.image"],
      })
    }
  }, [defaults, challenges?.[0]?.id, form, challenge?.id, initialModelId])

  useEffect(() => {
    if (!isThinkingLevelSupported) {
      form.setValue("thinkingLevel", firstSupportedThinkingLevel)
    }
  }, [isThinkingLevelSupported, firstSupportedThinkingLevel, form])

  const available = challenge ? [challenge] : (challenges ?? [])

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>启动任务</DialogTitle>
        <DialogDescription>
          {challenge
            ? `为 ${challenge.name} 配置一次任务。`
            : "为本次任务选择题目和模型。"}
        </DialogDescription>
      </DialogHeader>
      {(settings.isPending || providers.isPending) && (
        <DialogPanel>
          <div
            className="flex items-center gap-2 text-muted-foreground text-sm"
            role="status"
          >
            <Spinner aria-hidden="true" />
            正在加载默认值…
          </div>
        </DialogPanel>
      )}
      {(settings.error || providers.error) && (
        <DialogPanel>
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>无法加载任务配置</AlertTitle>
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
              重试
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
                <FieldLabel>题目</FieldLabel>
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
                        <SelectValue placeholder="选择题目" />
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
              <FieldLabel>模型</FieldLabel>
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
                      <SelectValue placeholder="没有已启用的模型" />
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
              <FieldLabel>推理</FieldLabel>
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
              <FieldLabel htmlFor="run-image">容器镜像</FieldLabel>
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
            <Alert>
              <Box />
              <AlertTitle>隔离容器</AlertTitle>
              <AlertDescription>
                pi 作为容器主进程运行，其工作区位于
                /workspace。可在「对话」标签页中监控并干预它。
              </AlertDescription>
            </Alert>
            {mutation.error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </DialogClose>
            <Button
              disabled={!modelId}
              loading={mutation.isPending}
              type="submit"
            >
              <Play /> 启动任务
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogPopup>
  )
}
