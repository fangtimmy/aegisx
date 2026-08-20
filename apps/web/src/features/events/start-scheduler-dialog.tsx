import { useMutation } from "@tanstack/react-query"
import { Play } from "lucide-react"
import { useState } from "react"

import { schedulerApi, type SchedulerInfo } from "@/api"
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
import { Switch } from "@/components/ui/switch"
import { ModelRefPicker } from "@/features/runs/model-switcher"
import { toast } from "@/lib/toast"

/** Pre-start dialog: pick the model (snapshotted into the run params at
 * creation) and optionally rebuild. Scheduling policy (instruction / target
 * cap) lives in the event settings — only the model is persisted here,
 * right before the start call. */
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
  // W3.2: reset=true discards the closed run's history (fresh start); the
  // default start cold-restores the closed scheduler keeping memory.
  const [reset, setReset] = useState(false)

  const saveConfig = useMutation({
    mutationFn: () => schedulerApi.updateSchedulerConfig(eventId, { modelId }),
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
    // Persist the model choice first — start resolves modelId into the
    // run's params snapshot at creation, so config must land first.
    saveConfig.mutate(undefined, {
      onSuccess: () => start.mutate(),
      onError: (error) => toast.error("保存模型失败", error.message),
    })
  }

  return (
    <Dialog onOpenChange={(open) => !open && !launching && onClose()} open>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>启动调度者</DialogTitle>
          <DialogDescription>
            确认模型与重建选项后启动；调度策略在赛事设置中调整。
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
            <Field>
              <FieldLabel>模型</FieldLabel>
              <FieldDescription>
                调度者本次运行使用的模型，启动时快照生效；留空则使用全局默认。
              </FieldDescription>
              <ModelRefPicker
                allowEmpty
                emptyLabel="全局默认"
                onChange={setModelId}
                value={modelId}
              />
            </Field>
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
