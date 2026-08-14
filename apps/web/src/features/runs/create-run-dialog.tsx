import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, CircleAlert, ListOrdered, Plus } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Link } from "react-router"

import {
  type Challenge,
  keys,
  orchestrationsApi,
  runsApi,
  settingsApi,
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
import { toast } from "@/lib/toast"

/** Orchestration display names for the picker. */
const ORCHESTRATION_LABELS: Record<string, string> = {
  classic: "Classic（单求解者）",
  "observer-solver": "Observer-Solver（求解者 + 观察者）",
  "bootstrap-solver": "Bootstrap-Solver",
  trio: "Trio（三个并行求解者）",
}

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
  const orchestrations = useQuery({
    queryKey: ["orchestrations"],
    queryFn: () => orchestrationsApi.listOrchestrations(),
  })

  const [orchestration, setOrchestration] = useState("classic")
  const [timeoutMinutes, setTimeoutMinutes] = useState(60)
  const [prompt, setPrompt] = useState("")
  const [challengeId, setChallengeId] = useState(available[0]?.id ?? "")

  const challengePlugins = useMemo(
    () =>
      (orchestrations.data?.items ?? []).filter(
        (plugin) => plugin.scope === "challenge"
      ),
    [orchestrations.data]
  )

  // Seed the timeout from the global default once settings arrive.
  useEffect(() => {
    const defaultMs = settings.data?.settings["scheduler.defaultRunTimeoutMs"]
    if (typeof defaultMs === "number" && defaultMs > 0) {
      setTimeoutMinutes(Math.round(defaultMs / 60_000))
    }
  }, [settings.data])

  const mutation = useMutation({
    mutationFn: () =>
      runsApi.createRun(challenge?.id ?? challengeId, {
        orchestration,
        timeoutMs: Math.max(1, Math.round(timeoutMinutes)) * 60_000,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
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

  const isLoading = settings.isPending || orchestrations.isPending
  const loadError = settings.error ?? orchestrations.error

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>启动任务</DialogTitle>
        <DialogDescription>
          {challenge
            ? `为 ${challenge.name} 选择编排，任务将进入队列。每个 agent 的模型在「设置 · 编排」中配置。`
            : "选择题目与编排，任务将进入队列。每个 agent 的模型在「设置 · 编排」中配置。"}
        </DialogDescription>
      </DialogHeader>
      {isLoading && (
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
      {loadError && (
        <DialogPanel>
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>无法加载任务配置</AlertTitle>
            <AlertDescription>{loadError.message}</AlertDescription>
            <Button
              onClick={() => {
                void settings.refetch()
                void orchestrations.refetch()
              }}
              type="button"
              variant="outline"
            >
              重试
            </Button>
          </Alert>
        </DialogPanel>
      )}
      {!isLoading && !loadError && (
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
            <Field>
              <FieldLabel>编排</FieldLabel>
              <Select
                items={Object.fromEntries(
                  challengePlugins.map((plugin) => [
                    plugin.id,
                    ORCHESTRATION_LABELS[plugin.id] ??
                      plugin.label ??
                      plugin.id,
                  ])
                )}
                onValueChange={(value) => setOrchestration(value ?? "")}
                value={orchestration}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {challengePlugins.map((plugin) => (
                    <SelectItem key={plugin.id} value={plugin.id}>
                      {ORCHESTRATION_LABELS[plugin.id] ??
                        plugin.label ??
                        plugin.id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                各 agent 的模型与提示词在{" "}
                <Link
                  className="font-medium underline"
                  to="/settings/orchestration"
                >
                  设置 · 编排
                </Link>{" "}
                中按编排配置。
              </p>
            </Field>
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
              <FieldLabel htmlFor="run-prompt">首轮提示词（可选）</FieldLabel>
              <Textarea
                id="run-prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="覆盖编排默认的 initial 提示词…"
                value={prompt}
              />
            </Field>
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
