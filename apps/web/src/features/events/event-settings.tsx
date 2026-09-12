import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Play,
  Server,
  Square,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { useNavigate } from "react-router"

import {
  agentsApi,
  type EventSummary,
  eventsApi,
  type FleetInfo,
  keys,
  schedulerApi,
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

import { ErrorState } from "./event-shared"
import { PlatformBinding } from "./platform-binding"
import { TargetsDialog } from "./targets-dialog"

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
  // Two independent forms: "名称" and "赛事简报" live in separate sections
  // and each save button only submits its own fields (Partial update), so
  // editing one never implicitly re-submits the other.
  const nameForm = useForm<{ name: string }>({
    defaultValues: { name: event.name },
  })
  const briefForm = useForm<{
    common: string
    solver: string
    orchestrator: string
  }>({
    defaultValues: {
      common: event.promptBrief?.common ?? "",
      solver: event.promptBrief?.solver ?? "",
      orchestrator: event.promptBrief?.orchestrator ?? "",
    },
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
  const updateBrief = useMutation({
    mutationFn: (input: {
      promptBrief: { common?: string; solver?: string; orchestrator?: string }
    }) => eventsApi.updateEvent(event.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.events.detail(event.id),
      })
      toast.success("赛事简报已保存")
    },
    onError: (error) => toast.error("保存简报失败", error.message),
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
  const clearChannels = useMutation({
    mutationFn: () => eventsApi.clearEventChannels(event.id),
    onSuccess: async () => {
      await invalidateEventCaches()
      toast.success("频道消息已清空")
    },
    onError: (error) => toast.error("清空频道失败", error.message),
  })
  const resetFlags = useMutation({
    mutationFn: () => eventsApi.resetEventFlags(event.id),
    onSuccess: async ({ reset }) => {
      await invalidateEventCaches()
      toast.success(`已重置 ${reset} 道题的解题进度`)
    },
    onError: (error) => toast.error("重置解题进度失败", error.message),
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
          <CardFrameTitle>赛事简报</CardFrameTitle>
          <CardFrameDescription>
            追加到本赛事 agent 提示词末尾的部署简报。通用段两类 agent
            都会读到；解题段只进 solver，调度段只进调度者——按读者拆开写，
            避免解题 agent 读到调度方针。
          </CardFrameDescription>
        </CardFrameHeader>
        <Card>
          <CardPanel>
            <form
              className="max-w-xl"
              onSubmit={briefForm.handleSubmit((values) =>
                updateBrief.mutate({
                  promptBrief: {
                    common: values.common.trim(),
                    solver: values.solver.trim(),
                    orchestrator: values.orchestrator.trim(),
                  },
                })
              )}
            >
              <Field>
                <FieldLabel htmlFor="event-brief-common">
                  通用（solver + 调度者）
                </FieldLabel>
                <Controller
                  control={briefForm.control}
                  name="common"
                  render={({ field }) => (
                    <Textarea
                      id="event-brief-common"
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      placeholder="平台、题型/难度语义、离线约束、flag 格式等两类 agent 都需要的事实。"
                      rows={4}
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Field className="mt-4">
                <FieldLabel htmlFor="event-brief-solver">
                  解题（仅 solver）
                </FieldLabel>
                <Controller
                  control={briefForm.control}
                  name="solver"
                  render={({ field }) => (
                    <Textarea
                      id="event-brief-solver"
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      placeholder="解题工作流、提交纪律、靶机注意事项——只进 solver 的系统提示词。"
                      rows={4}
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Field className="mt-4">
                <FieldLabel htmlFor="event-brief-orchestrator">
                  调度（仅调度者）
                </FieldLabel>
                <Controller
                  control={briefForm.control}
                  name="orchestrator"
                  render={({ field }) => (
                    <Textarea
                      id="event-brief-orchestrator"
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      placeholder="预算分档、优先级、让位规则——只进调度者的系统提示词。"
                      rows={4}
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Button
                className="mt-3"
                loading={updateBrief.isPending}
                type="submit"
              >
                保存简报
              </Button>
            </form>
            {updateBrief.error && (
              <Alert className="mt-3 max-w-xl" variant="error">
                <TriangleAlert />
                <AlertDescription>{updateBrief.error.message}</AlertDescription>
              </Alert>
            )}
          </CardPanel>
        </Card>
      </CardFrame>

      <SchedulerPolicyCard eventId={event.id} />

      <RuntimeControlCard
        event={event}
        invalidateEventCaches={invalidateEventCaches}
      />

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
              buttonLabel="清空全部频道"
              description="永久删除本赛事全部频道消息（#team 知识库、调度者通知、私信）及已读游标。需先关闭 live agent。"
              dialogTitle={`清空 ${event.name} 的全部频道消息？`}
              onConfirm={() => clearChannels.mutate()}
            />
            <DangerAction
              buttonLabel="重置解题进度"
              description="清空全部 flag 记录并复位解题状态（含缓存的平台判定）——所有题目回到未解出。需先关闭 live agent。"
              dialogTitle={`重置 ${event.name} 的全部解题进度？`}
              onConfirm={() => resetFlags.mutate()}
            />
            <DangerAction
              buttonLabel="清空题目"
              description="永久删除全部题目、附件及题目级运行记录。"
              dialogTitle={`清空 ${event.name} 的全部题目？`}
              onConfirm={() => purgeChallenges.mutate()}
            />
            <DangerAction
              buttonLabel="清空运行历史"
              description="永久删除全部运行记录及其容器、工作区与会话数据；题目与 flag 历史保留。运行中的 agent 将被强制中止。"
              dialogTitle={`清空 ${event.name} 的运行历史？`}
              onConfirm={() => purgeRuns.mutate()}
            />
            <DangerAction
              buttonLabel="删除赛事"
              description="永久删除本赛事及其题目、附件和任务历史。"
              dialogTitle={`删除 ${event.name}？`}
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
 * The model choice lives in the start dialog. Config comes from the fleet
 * endpoint (the scheduler config's canonical carrier). */
function SchedulerPolicyCard({ eventId }: { eventId: string }) {
  const fleet = useQuery({
    queryKey: keys.agents.fleet(eventId),
    queryFn: () => agentsApi.getFleet(eventId),
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
          {fleet.error ? (
            <ErrorState
              error={fleet.error}
              retry={() => void fleet.refetch()}
            />
          ) : fleet.data?.config ? (
            <SchedulerPolicyForm config={fleet.data.config} eventId={eventId} />
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
  stopSubmitterOnSolve: boolean
  nextTaskPolicy: "eager" | "drained"
  urgentTeamMessages: boolean
  blockSpawnOnSolved: boolean
}

/** Event-level runtime controls: the halt/resume combo (queue + scheduler +
 * inbox + agents + targets), the atomic close-all-agents, and the aggregated
 * remote-target manager. All reversible — the danger zone below is not. */
function RuntimeControlCard({
  event,
  invalidateEventCaches,
}: {
  event: EventSummary
  invalidateEventCaches: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const [haltOpen, setHaltOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [targetsOpen, setTargetsOpen] = useState(false)
  const fleet = useQuery({
    queryKey: keys.agents.fleet(event.id),
    queryFn: () => agentsApi.getFleet(event.id),
  })
  const queue = useQuery({
    queryKey: keys.scheduler.queue(event.id),
    queryFn: () => schedulerApi.listQueue(event.id),
  })
  const liveCount = Object.values(fleet.data?.agentsByChallenge ?? {})
    .flat()
    .filter(
      (agent) => agent.status === "running" || agent.status === "idle"
    ).length
  const halted = queue.data?.state === "paused"
  const afterMutation = async () => {
    await Promise.all([
      invalidateEventCaches(),
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(event.id),
      }),
    ])
  }
  const halt = useMutation({
    mutationFn: () => eventsApi.haltEvent(event.id),
    onSuccess: async (result) => {
      await afterMutation()
      toast.success(
        `已急停：关闭 ${result.closed} 个 agent、停止 ${result.targetsStopped} 台靶机`
      )
    },
    onError: (error) => toast.error("急停失败", error.message),
  })
  const resume = useMutation({
    mutationFn: () => eventsApi.resumeEvent(event.id),
    onSuccess: async () => {
      await afterMutation()
      toast.success("已恢复运行：调度者将重新同步，队列继续排水")
    },
    onError: (error) => toast.error("恢复运行失败", error.message),
  })
  const closeAll = useMutation({
    mutationFn: () => eventsApi.closeEventAgents(event.id),
    onSuccess: async ({ closed }) => {
      await afterMutation()
      toast.success(`已关闭 ${closed} 个 agent`)
    },
    onError: (error) => toast.error("关闭 agent 失败", error.message),
  })

  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>运行控制</CardFrameTitle>
        <CardFrameDescription>
          赛事级运行操作，全部可逆；不可逆的清除在下方危险区域。
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => setHaltOpen(true)}
              type="button"
              variant="destructive"
            >
              <Square /> 急停
            </Button>
            {halted && (
              <Button
                loading={resume.isPending}
                onClick={() => resume.mutate()}
                type="button"
                variant="outline"
              >
                <Play /> 恢复运行
              </Button>
            )}
            <Button
              disabled={liveCount === 0}
              onClick={() => setCloseOpen(true)}
              type="button"
              variant="destructive-outline"
            >
              <Users /> 关闭全部 Agent
            </Button>
            <Button
              onClick={() => setTargetsOpen(true)}
              type="button"
              variant="outline"
            >
              <Server /> 靶机
            </Button>
            <span className="text-sm text-muted-foreground">
              {liveCount} 个 live agent · {halted ? "队列已暂停" : "队列运行中"}
            </span>
          </div>
          {halt.error && (
            <Alert className="mt-3" variant="error">
              <TriangleAlert />
              <AlertDescription>{halt.error.message}</AlertDescription>
            </Alert>
          )}
        </CardPanel>
      </Card>
      <AlertDialog onOpenChange={setHaltOpen} open={haltOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              急停「{event.name}」的全部活动？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将关闭 {liveCount} 个 live agent（终态
              aborted，可随时唤醒）、暂停队列与调度者、停止全部靶机。排队任务保留，恢复运行后继续。此操作可逆。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </AlertDialogClose>
            <Button
              loading={halt.isPending}
              onClick={() => {
                halt.mutate()
                setHaltOpen(false)
              }}
              type="button"
              variant="destructive"
            >
              急停
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog onOpenChange={setCloseOpen} open={closeOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              关闭「{event.name}」的全部 live agent？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将关闭 {liveCount} 个 live agent（终态
              aborted，文件与会话保留，可随时唤醒）。队列与调度者不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </AlertDialogClose>
            <Button
              loading={closeAll.isPending}
              onClick={() => {
                closeAll.mutate()
                setCloseOpen(false)
              }}
              type="button"
              variant="destructive"
            >
              关闭全部 Agent
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <TargetsDialog
        eventId={event.id}
        onOpenChange={setTargetsOpen}
        open={targetsOpen}
      />
    </CardFrame>
  )
}

function SchedulerPolicyForm({
  eventId,
  config,
}: {
  eventId: string
  config: FleetInfo["config"]
}) {
  const queryClient = useQueryClient()
  const form = useForm<PolicyFormValues>({
    defaultValues: {
      instruction: config.instruction,
      maxTargets: config.maxConcurrentTargets,
      notifyTeamOnFlag: config.notifyTeamOnFlag,
      stopSiblingsOnSolve: config.stopSiblingsOnSolve,
      stopTargetOnSolve: config.stopTargetOnSolve,
      stopSubmitterOnSolve: config.stopSubmitterOnSolve,
      nextTaskPolicy: config.nextTaskPolicy,
      urgentTeamMessages: config.urgentTeamMessages,
      blockSpawnOnSolved: config.blockSpawnOnSolved,
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
        stopSubmitterOnSolve: input.stopSubmitterOnSolve,
        nextTaskPolicy: input.nextTaskPolicy,
        urgentTeamMessages: input.urgentTeamMessages,
        blockSpawnOnSolved: input.blockSpawnOnSolved,
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
          name="stopSubmitterOnSolve"
          render={({ field }) => (
            <PolicySwitch
              description="评测模式：完全解出后连提交者一并终止（不写 writeup，平台只计 flag）。关闭时提交者保留有界的收尾窗口完成 finish_run。"
              label="完全解出即终止提交者（评测）"
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
        <Controller
          control={form.control}
          name="blockSpawnOnSolved"
          render={({ field }) => (
            <PolicySwitch
              description="题目完全解出后，拒绝为它启动新 agent（排队项自动取消）。需要解出后复盘/复现（重打一遍）时临时关闭。"
              label="已解题禁止新 agent"
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
        <Switch checked={value} onCheckedChange={(c) => onChange(c)} />
      </div>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function DangerAction({
  buttonLabel,
  description,
  dialogTitle,
  onConfirm,
}: {
  buttonLabel: string
  description: string
  dialogTitle: string
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Field>
      <FieldLabel>{buttonLabel}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      <AlertDialog onOpenChange={setOpen} open={open}>
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
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </AlertDialogClose>
            <Button
              onClick={() => {
                onConfirm()
                setOpen(false)
              }}
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
