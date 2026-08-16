import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, UserPlus } from "lucide-react"
import { useState } from "react"

import { keys, type ModelRef, runsApi } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ModelRefPicker } from "@/features/runs/model-switcher"
import { toast } from "@/lib/toast"

const PROMPT_MODE_LABELS = {
  strategy: "追加到 Strategy（默认）",
  override: "完全替换 initial",
} as const

/** Run-detail「添加 solver」entry (POST /api/runs/:runId/agents, design
 * §3.3): one more solver with its own model + required prompt. A closed run
 * is cold-restored server-side (the old solvers stay dormant). */
export function AddSolverDialog({
  runId,
  eventId,
  nextIndex,
}: {
  runId: string
  eventId: string
  /** 1-based slot number the new solver will occupy (label only). */
  nextIndex: number
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [prompt, setPrompt] = useState("")
  const [mode, setMode] = useState<"strategy" | "override">("strategy")

  const mutation = useMutation({
    mutationFn: () =>
      runsApi.addRunAgent(runId, {
        prompt: prompt.trim(),
        ...(model ? { model } : {}),
        ...(mode === "override" ? { promptMode: mode } : {}),
      }),
    onSuccess: () => {
      toast.success(`Solver ${nextIndex} 已加入`)
      void queryClient.invalidateQueries({
        queryKey: keys.runs.detail(runId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.runs.fleet(eventId),
      })
      setOpen(false)
      setModel(null)
      setPrompt("")
      setMode("strategy")
    },
    onError: (error) => toast.error("添加 solver 失败", error.message),
  })

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <UserPlus /> 添加 solver
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>添加 Solver {nextIndex}</DialogTitle>
          <DialogDescription>
            为该 run 动态追加一个 solver；提示词必填。已关闭的 run
            会自动恢复容器，原有 solver 保持休眠。
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            if (prompt.trim()) mutation.mutate()
          }}
        >
          <DialogPanel className="grid gap-4">
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
              <FieldLabel htmlFor="solver-prompt">提示词</FieldLabel>
              <Textarea
                id="solver-prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="该 solver 的任务指派…"
                required
                value={prompt}
              />
            </Field>
            <Field>
              <FieldLabel>模式</FieldLabel>
              <Select
                items={PROMPT_MODE_LABELS}
                onValueChange={(value) =>
                  setMode((value ?? "strategy") as "strategy" | "override")
                }
                value={mode}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {(
                    Object.keys(PROMPT_MODE_LABELS) as Array<
                      keyof typeof PROMPT_MODE_LABELS
                    >
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {PROMPT_MODE_LABELS[value]}
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
            <Button
              disabled={!prompt.trim()}
              loading={mutation.isPending}
              type="submit"
            >
              添加
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
