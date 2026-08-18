import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { Trash2, TriangleAlert } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { useNavigate } from "react-router"

import { type EventSummary, eventsApi, keys } from "@/api"
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
      navigate("/")
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
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">赛事设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理本赛事及其平台连接。
        </p>
      </header>

      <section className="border-t py-6" aria-labelledby="event-general">
        <h2 className="text-base font-medium" id="event-general">
          常规
        </h2>
        <form
          className="mt-4 flex max-w-xl items-end gap-3"
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
      </section>

      <section className="border-t py-6" aria-labelledby="event-prompt-hint">
        <h2 className="text-base font-medium" id="event-prompt-hint">
          提示词指令
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          追加到本赛事每个 agent 提示词末尾的额外指令——flag
          格式、约定、常见陷阱。
        </p>
        <form
          className="mt-4 max-w-xl"
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
            <AlertDescription>{updatePrompt.error.message}</AlertDescription>
          </Alert>
        )}
      </section>

      <section className="border-t py-6" aria-labelledby="event-platform">
        <h2 className="text-base font-medium" id="event-platform">
          CTF 平台
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          连接本赛事以导入题目、附件和目标。
        </p>
        <PlatformBinding event={event} />
      </section>

      <section className="border-t py-6" aria-labelledby="event-danger">
        <h2
          className="text-base font-medium text-destructive"
          id="event-danger"
        >
          危险区域
        </h2>
        <div className="mt-4 max-w-xl space-y-8">
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
        </div>
      </section>
    </div>
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
