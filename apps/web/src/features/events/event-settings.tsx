import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, TriangleAlert } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { useNavigate } from "react-router"

import { type EventInput, type EventSummary, eventsApi, keys } from "@/api"
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
  const form = useForm<{ name: string; promptHint: string }>({
    defaultValues: { name: event.name, promptHint: event.promptHint ?? "" },
  })
  const update = useMutation({
    mutationFn: (input: EventInput) => eventsApi.updateEvent(event.id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.events.detail(event.id),
        }),
        queryClient.invalidateQueries({ queryKey: keys.events.all }),
      ])
      toast.success("赛事已更新")
    },
    onError: (error) => toast.error("更新赛事失败", error.message),
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
          onSubmit={form.handleSubmit((values) =>
            update.mutate({
              name: values.name.trim(),
              promptHint: values.promptHint.trim(),
            })
          )}
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="event-name">名称</FieldLabel>
            <Controller
              control={form.control}
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
          <Button loading={update.isPending} type="submit">
            保存
          </Button>
        </form>
        {update.error && (
          <Alert className="mt-3 max-w-xl" variant="error">
            <TriangleAlert />
            <AlertDescription>{update.error.message}</AlertDescription>
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
          onSubmit={form.handleSubmit((values) =>
            update.mutate({
              name: values.name.trim(),
              promptHint: values.promptHint.trim(),
            })
          )}
        >
          <Field>
            <Controller
              control={form.control}
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
          <Button className="mt-3" loading={update.isPending} type="submit">
            保存指令
          </Button>
        </form>
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
        <Field className="mt-4 max-w-xl">
          <FieldLabel>删除赛事</FieldLabel>
          <FieldDescription>
            永久删除本赛事及其题目、附件和任务历史。
          </FieldDescription>
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
              <Trash2 /> 删除赛事
            </AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>删除 {event.name}？</AlertDialogTitle>
                <AlertDialogDescription>
                  此操作无法撤销。必须先停止所有活跃任务。
                </AlertDialogDescription>
                {remove.error && (
                  <Alert variant="error">
                    <TriangleAlert />
                    <AlertDescription>{remove.error.message}</AlertDescription>
                  </Alert>
                )}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  render={<Button type="button" variant="ghost" />}
                >
                  取消
                </AlertDialogClose>
                <Button
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                  type="button"
                  variant="destructive"
                >
                  删除赛事
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </Field>
      </section>
    </div>
  )
}
