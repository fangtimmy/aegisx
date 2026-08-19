import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Play } from "lucide-react"
import { useEffect, useState } from "react"

import { keys, schedulerApi, type SchedulerInfo } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ModelRefPicker } from "@/features/runs/model-switcher"
import { toast } from "@/lib/toast"

export function SchedulerConfigTab({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: () => schedulerApi.getScheduler(eventId),
  })
  const config = scheduler.data?.config

  const [modelId, setModelId] = useState<string | null>(config?.modelId ?? null)
  const [instruction, setInstruction] = useState(config?.instruction ?? "")
  const [maxTargets, setMaxTargets] = useState(
    config?.maxConcurrentTargets ?? 1
  )
  useEffect(() => {
    if (!config) return
    setModelId(config.modelId)
    setInstruction(config.instruction)
    setMaxTargets(config.maxConcurrentTargets)
  }, [config])

  const save = useMutation({
    mutationFn: () =>
      schedulerApi.updateSchedulerConfig(eventId, {
        modelId,
        instruction,
        maxConcurrentTargets: maxTargets,
      }),
    onSuccess: () => {
      toast.success("调度者配置已保存")
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.detail(eventId),
      })
    },
    onError: (error) => toast.error("保存失败", error.message),
  })

  if (scheduler.isPending || !config) {
    return (
      <output className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        正在加载配置…
      </output>
    )
  }

  return (
    <ScrollArea className="h-full" scrollFade>
      <form
        className="flex flex-col gap-5 px-6 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <SchedulerStateBadge
          agent={scheduler.data?.agent ?? null}
          paused={config.paused}
        />
        <SchedulerConfigFields
          instruction={instruction}
          maxTargets={maxTargets}
          modelId={modelId}
          onInstructionChange={setInstruction}
          onMaxTargetsChange={setMaxTargets}
          onModelChange={setModelId}
        />
        <div className="flex justify-end">
          <Button loading={save.isPending} type="submit">
            保存配置
          </Button>
        </div>
      </form>
    </ScrollArea>
  )
}

/** W3.3: read-only scheduler state on the config page (controls live in the
 * graph panel — no duplicate buttons here). */
function SchedulerStateBadge({
  paused,
  agent,
}: {
  paused: boolean
  agent: SchedulerInfo["agent"]
}) {
  const active =
    (agent !== null && agent.status === "running") || agent?.status === "idle"
  const label = active ? (paused ? "已暂停" : "运行中") : "未启用"
  const variant = active ? (paused ? "warning" : "success") : "secondary"
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">调度者状态</span>
      <Badge size="sm" variant={variant}>
        {label}
      </Badge>
    </div>
  )
}

function SchedulerConfigFields({
  modelId,
  instruction,
  maxTargets,
  onModelChange,
  onInstructionChange,
  onMaxTargetsChange,
}: {
  modelId: string | null
  instruction: string
  maxTargets: number
  onModelChange: (value: string | null) => void
  onInstructionChange: (value: string) => void
  onMaxTargetsChange: (value: number) => void
}) {
  return (
    <>
      <Field>
        <FieldLabel>默认模型</FieldLabel>
        <FieldDescription>
          调度者启动时使用的模型；留空则使用全局默认。
        </FieldDescription>
        <ModelRefPicker
          allowEmpty
          emptyLabel="全局默认"
          onChange={onModelChange}
          value={modelId}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="sched-instruction">指令</FieldLabel>
        <FieldDescription>
          追加到调度者系统提示词末尾的常驻指令。
        </FieldDescription>
        <Textarea
          id="sched-instruction"
          onChange={(event) => onInstructionChange(event.target.value)}
          rows={6}
          value={instruction}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="sched-targets">并发靶机上限</FieldLabel>
        <NumberField
          id="sched-targets"
          min={1}
          onValueChange={(value) => {
            if (typeof value === "number") onMaxTargetsChange(value)
          }}
          value={maxTargets}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </Field>
    </>
  )
}

export function StartSchedulerDialog({
  eventId,
  config,
  onClose,
  onStarted,
}: {
  eventId: string
  config?: SchedulerInfo["config"]
  onClose: () => void
  onStarted: () => Promise<unknown> | void
}) {
  const [modelId, setModelId] = useState<string | null>(config?.modelId ?? null)
  const [instruction, setInstruction] = useState(config?.instruction ?? "")
  const [maxTargets, setMaxTargets] = useState(
    config?.maxConcurrentTargets ?? 1
  )
  // W3.2: reset=true discards the closed run's history (fresh start); the
  // default start cold-restores the closed scheduler keeping memory.
  const [reset, setReset] = useState(false)

  const saveConfig = useMutation({
    mutationFn: () =>
      schedulerApi.updateSchedulerConfig(eventId, {
        modelId,
        instruction,
        maxConcurrentTargets: maxTargets,
      }),
  })
  const start = useMutation({
    mutationFn: () => schedulerApi.startScheduler(eventId, reset),
    onSuccess: () => {
      toast.success(reset ? "调度者已重建" : "调度者已启动")
      void onStarted()
      onClose()
    },
    onError: (error) => toast.error("启动调度者失败", error.message),
  })
  const launching = saveConfig.isPending || start.isPending

  const launch = () => {
    // Persist the pre-start policy first — start resolves modelId/instruction
    // into the run's params snapshot at creation, so config must land first.
    saveConfig.mutate(undefined, {
      onSuccess: () => start.mutate(),
      onError: (error) => toast.error("保存配置失败", error.message),
    })
  }

  return (
    <Dialog onOpenChange={(open) => !open && !launching && onClose()} open>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>启动调度者</DialogTitle>
          <DialogDescription>
            启动前确认调度策略；配置会持久化，本次启动即生效。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              launch()
            }}
          >
            <SchedulerConfigFields
              instruction={instruction}
              maxTargets={maxTargets}
              modelId={modelId}
              onInstructionChange={setInstruction}
              onMaxTargetsChange={setMaxTargets}
              onModelChange={setModelId}
            />
            <Field>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <FieldLabel>重建调度者</FieldLabel>
                  <FieldDescription>
                    勾选后丢弃已关闭调度者的历史与会话，全新启动；默认保留记忆（冷恢复）。
                  </FieldDescription>
                </div>
                <Switch
                  aria-label="重建调度者（丢弃历史）"
                  checked={reset}
                  onCheckedChange={setReset}
                />
              </div>
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                disabled={launching}
                onClick={onClose}
                type="button"
                variant="ghost"
              >
                取消
              </Button>
              <Button loading={launching} type="submit">
                <Play /> 启动调度者
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
