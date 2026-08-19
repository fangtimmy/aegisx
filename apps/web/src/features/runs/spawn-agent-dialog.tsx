import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ListOrdered, Plus, Rocket } from "lucide-react"
import { CircleAlert } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"

import {
  agentsApi,
  type Challenge,
  keys,
  type ModelRef,
  type QueueItem,
  type AgentSummary,
  settingsApi,
} from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Label } from "@/components/ui/label"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { Radio, RadioGroup } from "@/components/ui/radio-group"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ModelRefPicker } from "@/features/runs/model-switcher"
import { toast } from "@/lib/toast"

const PROMPT_MODE_LABELS = {
  strategy: "追加到 Strategy（默认）",
  override: "完全替换 initial",
} as const

type SpawnAgentDialogProps = {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  eventId?: string
  trigger?: ReactNode
  triggerClassName?: string
  triggerLabel?: string
  triggerSize?: ButtonProps["size"]
  triggerVariant?: ButtonProps["variant"]
  onSpawned?: () => void
}

export function SpawnAgentDialog({
  challenges,
  challenge,
  eventId,
  trigger,
  triggerClassName,
  triggerLabel,
  triggerSize,
  triggerVariant,
  onSpawned,
}: SpawnAgentDialogProps) {
  const [open, setOpen] = useState(false)
  const available = challenge ? [challenge] : (challenges ?? [])

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={
          trigger
            ? (triggerLabel ??
              (challenge ? `为 ${challenge.name} 启动 agent` : "启动 agent"))
            : undefined
        }
        render={
          <Button
            className={triggerClassName}
            disabled={available.length === 0}
            size={trigger ? triggerSize : undefined}
            type="button"
            variant={trigger ? triggerVariant : undefined}
          />
        }
      >
        {trigger ?? (
          <>
            <Plus /> 启动 agent
          </>
        )}
      </DialogTrigger>
      {open ? (
        <SpawnAgentDialogContent
          challenge={challenge}
          challenges={challenges}
          eventId={eventId}
          onClose={() => setOpen(false)}
          onSpawned={onSpawned}
        />
      ) : null}
    </Dialog>
  )
}

function SpawnAgentDialogContent({
  challenges,
  challenge,
  eventId,
  onSpawned,
  onClose,
}: {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  eventId?: string
  onSpawned?: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const available = challenge ? [challenge] : (challenges ?? [])

  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })

  const [model, setModel] = useState<ModelRef | null>(null)
  const [prompt, setPrompt] = useState("")
  const [promptMode, setPromptMode] = useState<"strategy" | "override">(
    "strategy"
  )
  const [timeoutMinutes, setTimeoutMinutes] = useState(60)
  const [challengeId, setChallengeId] = useState(available[0]?.id ?? "")
  const [mode, setMode] = useState<"start" | "queue">("start")

  useEffect(() => {
    const defaultMs = settings.data?.settings["scheduler.defaultRunTimeoutMs"]
    if (typeof defaultMs === "number" && defaultMs > 0) {
      setTimeoutMinutes(Math.round(defaultMs / 60_000))
    }
  }, [settings.data])

  const mutation = useMutation({
    mutationFn: (): Promise<QueueItem | AgentSummary> => {
      const id = challenge?.id ?? challengeId
      const input = {
        timeoutMs: Math.max(1, Math.round(timeoutMinutes)) * 60_000,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(prompt.trim() && promptMode === "override"
          ? { promptMode: "override" as const }
          : {}),
        ...(model ? { model } : {}),
      }
      // Queue mode needs the eventId (POST /api/events/:id/queue).
      return mode === "start"
        ? agentsApi.spawnAgent(id, input)
        : agentsApi.enqueueSpawn(eventId ?? "", { challengeId: id, ...input })
    },
    onSuccess: (result) => {
      toast.success(mode === "start" ? "agent 已启动" : "已加入队列")
      const eid = "eventId" in result ? result.eventId : eventId
      if (eid) {
        void queryClient.invalidateQueries({
          queryKey: keys.agents.fleet(eid),
        })
        void queryClient.invalidateQueries({
          queryKey: keys.scheduler.queue(eid),
        })
        void queryClient.invalidateQueries({
          queryKey: keys.events.detail(eid),
        })
      }
      void queryClient.invalidateQueries({ queryKey: keys.events.all })
      onClose()
      onSpawned?.()
    },
    onError: (error) =>
      toast.error(mode === "start" ? "启动失败" : "入队失败", error.message),
  })

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>启动 agent</DialogTitle>
        <DialogDescription>
          {challenge
            ? `为 ${challenge.name} 启动 agent，${mode === "start" ? "立即启动" : "加入队列"}。`
            : `选择题目并启动 agent，${mode === "start" ? "立即启动" : "加入队列"}。`}
        </DialogDescription>
      </DialogHeader>
      {settings.isPending && (
        <DialogPanel>
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            正在加载配置…
          </output>
        </DialogPanel>
      )}
      {settings.error && (
        <DialogPanel>
          <Alert variant="error">
            <CircleAlert />
            <AlertDescription>{settings.error.message}</AlertDescription>
            <Button
              onClick={() => void settings.refetch()}
              type="button"
              variant="outline"
            >
              重试
            </Button>
          </Alert>
        </DialogPanel>
      )}
      {!settings.isPending && !settings.error && (
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            if (!(challenge ?? available[0])) return
            mutation.mutate()
          }}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>启动方式</FieldLabel>
              <RadioGroup
                aria-label="启动方式"
                className="flex-row flex-wrap gap-4"
                onValueChange={(value) => {
                  if (value === "start" || value === "queue") setMode(value)
                }}
                value={mode}
              >
                <Label className="flex cursor-pointer items-center gap-2">
                  <Radio value="start" />
                  直接启动
                </Label>
                <Label className="flex cursor-pointer items-center gap-2">
                  <Radio value="queue" />
                  加入队列
                </Label>
              </RadioGroup>
              <p className="text-xs text-muted-foreground">
                {mode === "start"
                  ? "立即启动，旁路队列；容量满时直接报错。同一题可并行多个 agent。"
                  : "容量满时排队等待，槽位释放后自动启动。"}
              </p>
            </Field>
            {!challenge && (
              <Field>
                <FieldLabel>题目</FieldLabel>
                <Select
                  items={Object.fromEntries(
                    available.map((item) => [item.id, item.name])
                  )}
                  onValueChange={(value) => setChallengeId(value ?? "")}
                  value={challengeId}
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
              </Field>
            )}
            <Field>
              <FieldLabel>模型</FieldLabel>
              <ModelRefPicker
                allowEmpty
                emptyLabel="全局默认"
                onChange={setModel}
                value={model}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="spawn-timeout">超时（分钟）</FieldLabel>
              <NumberField
                id="spawn-timeout"
                min={1}
                onValueChange={(value) => {
                  if (typeof value === "number") setTimeoutMinutes(value)
                }}
                value={timeoutMinutes}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
            <Field>
              <FieldLabel htmlFor="spawn-prompt">Strategy（可选）</FieldLabel>
              <Textarea
                id="spawn-prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="agent 策略，追加到首轮提示词的 Strategy 段…"
                value={prompt}
              />
              <Select
                disabled={!prompt.trim()}
                items={PROMPT_MODE_LABELS}
                onValueChange={(value) =>
                  setPromptMode(
                    (value ?? "strategy") as "strategy" | "override"
                  )
                }
                value={promptMode}
              >
                <SelectTrigger className="h-8 text-xs" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {(
                    Object.keys(PROMPT_MODE_LABELS) as Array<
                      keyof typeof PROMPT_MODE_LABELS
                    >
                  ).map((m) => (
                    <SelectItem key={m} value={m}>
                      {PROMPT_MODE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
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
            <Button loading={mutation.isPending} type="submit">
              {mode === "start" ? (
                <>
                  <Rocket /> 直接启动
                </>
              ) : (
                <>
                  <ListOrdered /> 加入队列
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogPopup>
  )
}
