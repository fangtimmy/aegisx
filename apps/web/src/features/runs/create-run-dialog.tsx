import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, ChevronDown, CircleAlert, ListOrdered, Plus } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"

import {
  type Challenge,
  keys,
  type ModelRef,
  runsApi,
  settingsApi,
} from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, type ButtonProps } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
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

const MAX_SOLVERS = 4

const PROMPT_MODE_LABELS = {
  strategy: "追加到 Strategy（默认）",
  override: "完全替换 initial",
} as const

/** One advanced per-solver row (model + prompt + mode). */
type SolverRow = {
  model: ModelRef | null
  prompt: string
  mode: "strategy" | "override"
}

const emptyRow = (): SolverRow => ({
  model: null,
  prompt: "",
  mode: "strategy",
})

type CreateRunDialogProps = {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  trigger?: ReactNode
  triggerClassName?: string
  triggerLabel?: string
  triggerSize?: ButtonProps["size"]
  triggerVariant?: ButtonProps["variant"]
  onCreated?: () => void
}

export function CreateRunDialog({
  challenges,
  challenge,
  trigger,
  triggerClassName,
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
            className={triggerClassName}
            disabled={available.length === 0}
            // Only force an icon size when the caller asks for one; a custom
            // trigger without a size should render as a normal button so the
            // caller can drive width/height via triggerClassName (icon-xs
            // would otherwise lock the button to a fixed square and clip the
            // content — tailwind-merge won't override size-* with w/h-*).
            size={trigger ? triggerSize : undefined}
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
  const queryClient = useQueryClient()
  const available = challenge ? [challenge] : (challenges ?? [])

  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })

  const [solverCount, setSolverCount] = useState(1)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [strategy, setStrategy] = useState("")
  const [rows, setRows] = useState<SolverRow[]>(() =>
    Array.from({ length: MAX_SOLVERS }, emptyRow)
  )
  const [timeoutMinutes, setTimeoutMinutes] = useState(60)
  const [challengeId, setChallengeId] = useState(available[0]?.id ?? "")

  // Seed the timeout from the global default once settings arrive.
  useEffect(() => {
    const defaultMs = settings.data?.settings["scheduler.defaultRunTimeoutMs"]
    if (typeof defaultMs === "number" && defaultMs > 0) {
      setTimeoutMinutes(Math.round(defaultMs / 60_000))
    }
  }, [settings.data])

  // The rows visible under the current solver count.
  const visibleRows = rows.slice(0, solverCount)
  // Advanced = any per-solver customization; then the solvers array wins over
  // the run-level model (server-side precedence, design §3.5).
  const advanced = visibleRows.some((row) => row.model || row.prompt.trim())

  const mutation = useMutation({
    mutationFn: () =>
      runsApi.createRun(challenge?.id ?? challengeId, {
        timeoutMs: Math.max(1, Math.round(timeoutMinutes)) * 60_000,
        solver_count: solverCount,
        ...(strategy.trim() ? { strategy: strategy.trim() } : {}),
        ...(advanced
          ? {
              solvers: visibleRows.map((row) => ({
                // Fall back to the run-level model for untouched rows.
                ...((row.model ?? model) ? { model: row.model ?? model! } : {}),
                ...(row.prompt.trim() ? { prompt: row.prompt.trim() } : {}),
                ...(row.prompt.trim() && row.mode === "override"
                  ? { promptMode: "override" as const }
                  : {}),
              })),
            }
          : { ...(model ? { model } : {}) }),
      }),
    onSuccess: (item) => {
      toast.success("任务已加入队列")
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(item.eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.runs.byEvent(item.eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.events.detail(item.eventId),
      })
      void queryClient.invalidateQueries({ queryKey: keys.events.all })
      onClose()
      onCreated?.()
    },
    onError: (error) => toast.error("入队失败", error.message),
  })

  const patchRow = (index: number, patch: Partial<SolverRow>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )
  }

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>启动任务</DialogTitle>
        <DialogDescription>
          {challenge
            ? `为 ${challenge.name} 启动求解任务，任务将进入队列。`
            : "选择题目并启动求解任务，任务将进入队列。"}
        </DialogDescription>
      </DialogHeader>
      {settings.isPending && (
        <DialogPanel>
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner aria-hidden="true" />
            正在加载配置…
          </div>
        </DialogPanel>
      )}
      {settings.error && (
        <DialogPanel>
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>无法加载任务配置</AlertTitle>
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
            <div className="grid grid-cols-2 items-start gap-4">
              <Field>
                <FieldLabel htmlFor="run-solvers">Solver 数</FieldLabel>
                <NumberField
                  id="run-solvers"
                  max={MAX_SOLVERS}
                  min={1}
                  onValueChange={(value) => {
                    if (
                      typeof value === "number" &&
                      Number.isInteger(value) &&
                      value >= 1 &&
                      value <= MAX_SOLVERS
                    ) {
                      setSolverCount(value)
                    }
                  }}
                  value={solverCount}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement />
                    <NumberFieldInput />
                    <NumberFieldIncrement />
                  </NumberFieldGroup>
                </NumberField>
                <p className="text-xs text-muted-foreground">
                  并行求解者共享同一工作区（上限 {MAX_SOLVERS}）。
                </p>
              </Field>
              <Field>
                <FieldLabel>模型</FieldLabel>
                <ModelRefPicker
                  allowEmpty
                  emptyLabel="全局默认"
                  onChange={setModel}
                  value={model}
                />
                <p className="text-xs text-muted-foreground">
                  应用于全部 solver；高级中可逐个覆盖。
                </p>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="run-timeout">超时（分钟）</FieldLabel>
              <NumberField
                id="run-timeout"
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
              <FieldLabel htmlFor="run-strategy">Strategy（可选）</FieldLabel>
              <Textarea
                id="run-strategy"
                onChange={(event) => setStrategy(event.target.value)}
                placeholder="run 级策略，追加到每个 solver 首轮提示词的 Strategy 段…"
                value={strategy}
              />
            </Field>
            <Collapsible>
              <CollapsibleTrigger
                className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
                type="button"
              >
                <ChevronDown className="size-4 transition-transform data-panel-open:rotate-180" />
                高级：逐 solver 规格
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-4 pt-2">
                {visibleRows.map((row, index) => (
                  <div className="grid gap-2 rounded-lg border p-3" key={index}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        Solver {index + 1}
                      </span>
                      <ModelRefPicker
                        allowEmpty
                        emptyLabel="跟随上方模型"
                        onChange={(ref) => patchRow(index, { model: ref })}
                        size="sm"
                        value={row.model}
                      />
                    </div>
                    <Textarea
                      aria-label={`Solver ${index + 1} 专属提示词`}
                      onChange={(event) =>
                        patchRow(index, { prompt: event.target.value })
                      }
                      placeholder="该 solver 的专属提示词（可选）…"
                      value={row.prompt}
                    />
                    <Select
                      disabled={!row.prompt.trim()}
                      items={PROMPT_MODE_LABELS}
                      onValueChange={(value) =>
                        patchRow(index, {
                          mode: (value ?? "strategy") as SolverRow["mode"],
                        })
                      }
                      value={row.mode}
                    >
                      <SelectTrigger className="h-8 text-xs" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {(
                          Object.keys(PROMPT_MODE_LABELS) as Array<
                            keyof typeof PROMPT_MODE_LABELS
                          >
                        ).map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {PROMPT_MODE_LABELS[mode]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
            <Alert>
              <Box />
              <AlertTitle>容器工具箱</AlertTitle>
              <AlertDescription>
                agent 在宿主机端以进程内方式运行；启动后会拉起一个 Kali
                工具箱容器（<code className="font-mono">sleep infinity</code>
                ），bash 在其中运行，配备完整 CTF
                工具链。任务进入队列后按全局并发上限（
                <code className="font-mono">调度器 · 最大并发任务数</code>
                ）排队启动。
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
            <Button loading={mutation.isPending} type="submit">
              <ListOrdered /> 加入队列
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogPopup>
  )
}
