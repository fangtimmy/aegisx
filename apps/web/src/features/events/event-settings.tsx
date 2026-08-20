import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Trash2, TriangleAlert } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { useNavigate } from "react-router"

import {
  type EventSummary,
  eventsApi,
  keys,
  schedulerApi,
  type SchedulerInfo,
} from "@/api"
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
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"

import { PlatformBinding } from "./platform-binding"

export function EventSettings({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const invalidateEventCaches = async () => {
    // events.detail is the prefix of the scheduler/queue/inbox keys and
    // runs.byEvent of the fleet key, so three invalidations cover all views.
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: keys.events.detail(event.id),
      }),
      queryClient.invalidateQueries({ queryKey: keys.events.all }),
      queryClient.invalidateQueries({ queryKey: keys.agents.fleet(event.id) }),
    ])
  }
  // Two independent forms: "名称" and "提示词指令" live in separate sections
  // and each save button only submits its own field (Partial update), so
  // editing one never implicitly re-submits the other.
  const nameForm = useForm<{ name: string }>({
    defaultValues: { name: event.name },
  })
  const promptForm = useForm<{ promptHint: string }>({
    defaultValues: { promptHint: event.promptHint ?? "" },
  })
  const updateName = useMutation({
    mutationFn: (input: { name: string }) =>
      eventsApi.updateEvent(event.id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.events.detail(event.id),
        }),
        queryClient.invalidateQueries({ queryKey: keys.events.all }),
      ])
      toast.success("名称已更新")
    },
    onError: (error) => toast.error("更新名称失败", error.message),
  })
  const updatePrompt = useMutation({
    mutationFn: (input: { promptHint: string }) =>
      eventsApi.updateEvent(event.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.events.detail(event.id),
      })
      toast.success("提示词指令已保存")
    },
    onError: (error) => toast.error("保存指令失败", error.message),
  })
  const remove = useMutation({
    mutationFn: () => eventsApi.deleteEvent(event.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.events.all })
      toast.success("赛事已删除")
      void navigate("/")
    },
    onError: (error) => toast.error("删除赛事失败", error.message),
  })
  const purgeChallenges = useMutation({
    mutationFn: () => eventsApi.deleteEventChallenges(event.id),
    onSuccess: async () => {
      await invalidateEventCaches()
      toast.success("题目已清空")
    },
    onError: (error) => toast.error("清空题目失败", error.message),
  })
  const purgeRuns = useMutation({
    mutationFn: () => eventsApi.deleteEventAgents(event.id),
    onSuccess: async () => {
      await invalidateEventCaches()
      toast.success("运行历史已清空")
    },
    onError: (error) => toast.error("清空运行历史失败", error.message),
  })

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">赛事设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理本赛事及其平台连接。
        </p>
      </header>

      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>常规</CardFrameTitle>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <form
              className="flex max-w-xl items-end gap-3"
              onSubmit={nameForm.handleSubmit((values) =>
                updateName.mutate({ name: values.name.trim() })
              )}
            >
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="event-name">名称</FieldLabel>
                <Controller
                  control={nameForm.control}
                  name="name"
                  render={({ field }) => (
                    <Input
                      id="event-name"
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
              <Button loading={updateName.isPending} type="submit">
                保存
              </Button>
            </form>
            {updateName.error && (
              <Alert className="mt-3 max-w-xl" variant="error">
                <TriangleAlert />
                <AlertDescription>{updateName.error.message}</AlertDescription>
              </Alert>
            )}
          </CardPanel>
        </Card>
      </CardFrame>

      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>提示词指令</CardFrameTitle>
          <CardFrameDescription>
            追加到本赛事每个 agent 提示词末尾的额外指令——flag
            格式、约定、常见陷阱。
          </CardFrameDescription>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <form
              className="max-w-xl"
              onSubmit={promptForm.handleSubmit((values) =>
                updatePrompt.mutate({ promptHint: values.promptHint.trim() })
              )}
            >
              <Field>
                <Controller
                  control={promptForm.control}
                  name="promptHint"
                  render={({ field }) => (
                    <Textarea
                      id="event-prompt-hint"
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      placeholder="例如：flag 格式为 moectf{...}。仅提交匹配该格式的 flag。"
                      rows={6}
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Button
                className="mt-3"
                loading={updatePrompt.isPending}
                type="submit"
              >
                保存指令
              </Button>
            </form>
            {updatePrompt.error && (
              <Alert className="mt-3 max-w-xl" variant="error">
                <TriangleAlert />
                <AlertDescription>
                  {updatePrompt.error.message}
                </AlertDescription>
              </Alert>
            )}
          </CardPanel>
        </Card>
      </CardFrame>

      <SchedulerPolicyCard eventId={event.id} />

      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>CTF 平台</CardFrameTitle>
          <CardFrameDescription>
            连接本赛事以导入题目、附件和目标。
          </CardFrameDescription>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <PlatformBinding event={event} />
          </CardPanel>
        </Card>
      </CardFrame>

      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle className="text-destructive">危险区域</CardFrameTitle>
        </CardFrameHeader>
        <Card>
          <CardPanel className="space-y-8">
            <DangerAction
              buttonLabel="清空题目"
              description="永久删除全部题目、附件及题目级运行记录。"
              dialogTitle={`清空 ${event.name} 的全部题目？`}
              mutation={purgeChallenges}
              onConfirm={() => purgeChallenges.mutate()}
            />
            <DangerAction
              buttonLabel="清空运行历史"
              description="永久删除全部运行记录及其容器、工作区与会话数据；题目与 flag 历史保留。运行中的 agent 将被强制中止。"
              dialogTitle={`清空 ${event.name} 的运行历史？`}
              mutation={purgeRuns}
              onConfirm={() => purgeRuns.mutate()}
            />
            <DangerAction
              buttonLabel="删除赛事"
              description="永久删除本赛事及其题目、附件和任务历史。"
              dialogTitle={`删除 ${event.name}？`}
              mutation={remove}
              onConfirm={() => remove.mutate()}
            />
          </CardPanel>
        </Card>
      </CardFrame>
    </div>
  )
}

/** 调度策略 card: the scheduler's per-event policy — instruction (snapshotted
 * at scheduler start) + concurrent-target cap (live, read by the spawn fence).
 * The model choice lives in the start dialog. */
function SchedulerPolicyCard({ eventId }: { eventId: string }) {
  const scheduler = useQuery({
    queryKey: keys.scheduler.detail(eventId),
    queryFn: () => schedulerApi.getScheduler(eventId),
  })

  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>调度策略</CardFrameTitle>
        <CardFrameDescription>
          本赛事的调度者策略；指令在下次启动时生效，并发上限实时生效。
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel>
          {scheduler.data?.config ? (
            <SchedulerPolicyForm
              config={scheduler.data.config}
              eventId={eventId}
            />
          ) : (
            <output className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" /> 正在加载调度策略…
            </output>
          )}
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

type PolicyFormValues = {
  instruction: string
  maxTargets: number
  notifyTeamOnFlag: boolean
  stopSiblingsOnSolve: boolean
  stopTargetOnSolve: boolean
  nextTaskPolicy: "eager" | "drained"
  urgentTeamMessages: boolean
}

function SchedulerPolicyForm({
  eventId,
  config,
}: {
  eventId: string
  config: SchedulerInfo["config"]
}) {
  const queryClient = useQueryClient()
  const form = useForm<PolicyFormValues>({
    defaultValues: {
      instruction: config.instruction,
      maxTargets: config.maxConcurrentTargets,
      notifyTeamOnFlag: config.notifyTeamOnFlag,
      stopSiblingsOnSolve: config.stopSiblingsOnSolve,
      stopTargetOnSolve: config.stopTargetOnSolve,
      nextTaskPolicy: config.nextTaskPolicy,
      urgentTeamMessages: config.urgentTeamMessages,
    },
  })
  const save = useMutation({
    mutationFn: (input: PolicyFormValues) =>
      schedulerApi.updateSchedulerConfig(eventId, {
        instruction: input.instruction.trim(),
        maxConcurrentTargets: Math.max(1, Math.round(input.maxTargets)),
        notifyTeamOnFlag: input.notifyTeamOnFlag,
        stopSiblingsOnSolve: input.stopSiblingsOnSolve,
        stopTargetOnSolve: input.stopTargetOnSolve,
        nextTaskPolicy: input.nextTaskPolicy,
        urgentTeamMessages: input.urgentTeamMessages,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.detail(eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.agents.fleet(eventId),
      })
      toast.success("调度策略已保存")
    },
    onError: (error) => toast.error("保存调度策略失败", error.message),
  })

  return (
    <form
      className="max-w-xl"
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
    >
      <Field>
        <FieldLabel>调度者指令</FieldLabel>
        <FieldDescription>
          追加到调度者系统提示词末尾的常驻策略（优先方向、节奏偏好）；下次启动时生效。
        </FieldDescription>
        <Controller
          control={form.control}
          name="instruction"
          render={({ field }) => (
            <Textarea
              id="sched-policy-instruction"
              onBlur={field.onBlur}
              onChange={field.onChange}
              rows={6}
              value={field.value}
            />
          )}
        />
      </Field>
      <Field className="mt-4">
        <FieldLabel htmlFor="sched-policy-targets">并发靶机上限</FieldLabel>
        <FieldDescription>
          本赛事同时进攻的不同题目数上限，实时生效；同一题的多个尝试共享一个槽位。
        </FieldDescription>
        <Controller
          control={form.control}
          name="maxTargets"
          render={({ field }) => (
            <NumberField
              id="sched-policy-targets"
              min={1}
              onValueChange={(value) => {
                if (typeof value === "number") field.onChange(value)
              }}
              value={field.value}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          )}
        />
      </Field>
      <div className="mt-5 space-y-4 border-t pt-5">
        <Controller
          control={form.control}
          name="nextTaskPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>下一题启动时机</FieldLabel>
              <FieldDescription>
                eager：本题解出即让出靶机槽，下一题立刻启动（上题 agent
                并存收尾）；drained：本题全部 agent
                结束后才启动下一题，严格串行。
              </FieldDescription>
              <Select
                items={{
                  eager: "立即（解出即启下一题）",
                  drained: "等待（本题全部结束后）",
                }}
                onValueChange={(value) => field.onChange(value)}
                value={field.value}
              >
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="eager">立即（解出即启下一题）</SelectItem>
                  <SelectItem value="drained">
                    等待（本题全部结束后）
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="notifyTeamOnFlag"
          render={({ field }) => (
            <PolicySwitch
              description="flag 被平台接受后，系统在 #team 发布题名、flag 与解出者；关闭时不发（agent 自行发帖）。"
              label="flag 接受后通知 #team"
              onChange={field.onChange}
              value={field.value}
            />
          )}
        />
        <Controller
          control={form.control}
          name="stopSiblingsOnSolve"
          render={({ field }) => (
            <PolicySwitch
              description="完全解出后立即终止同题其他 agent（提交者保留写 writeup）；关闭时队友会收到收尾通知并自然结束。"
              label="完全解出后停止同题 agent"
              onChange={field.onChange}
              value={field.value}
            />
          )}
        />
        <Controller
          control={form.control}
          name="stopTargetOnSolve"
          render={({ field }) => (
            <PolicySwitch
              description="完全解出后立即停止平台靶机实例；关闭时靶机保留给同题 agent 验证（注意平台资源占用）。"
              label="完全解出后停靶机"
              onChange={field.onChange}
              value={field.value}
            />
          )}
        />
        <Controller
          control={form.control}
          name="urgentTeamMessages"
          render={({ field }) => (
            <PolicySwitch
              description="所有 #team 消息立即投递给队友（不等 5 分钟合并）；协作更即时，代价是回合被更频繁注入。"
              label="#team 消息全部按紧急投递"
              onChange={field.onChange}
              value={field.value}
            />
          )}
        />
      </div>
      <Button className="mt-3" loading={save.isPending} type="submit">
        保存策略
      </Button>
      {save.error && (
        <Alert className="mt-3 max-w-xl" variant="error">
          <TriangleAlert />
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/** Label + description with the switch right-aligned on the label row. */
function PolicySwitch({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-4">
        <FieldLabel className="font-normal">{label}</FieldLabel>
        <Switch checked={value} onCheckedChange={(c) => onChange(c === true)} />
      </div>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function DangerAction({
  buttonLabel,
  description,
  dialogTitle,
  mutation,
  onConfirm,
}: {
  buttonLabel: string
  description: string
  dialogTitle: string
  mutation: UseMutationResult<unknown, Error, void, unknown>
  onConfirm: () => void
}) {
  return (
    <Field>
      <FieldLabel>{buttonLabel}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              className="mt-2 w-fit"
              type="button"
              variant="destructive"
            />
          }
        >
          <Trash2 /> {buttonLabel}
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              此操作无法撤销。必须先停止所有活跃任务。
            </AlertDialogDescription>
            {mutation.error && (
              <Alert variant="error">
                <TriangleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </AlertDialogClose>
            <Button
              loading={mutation.isPending}
              onClick={onConfirm}
              type="button"
              variant="destructive"
            >
              {buttonLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Field>
  )
}
