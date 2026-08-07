import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  ArrowRight,
  CalendarDays,
  Clock3,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { Link } from "react-router"

import { type EventInput, type EventSummary, eventsApi, keys } from "@/api"
import { AppLayout } from "@/components/shell/app-layout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameFooter,
  CardPanel,
} from "@/components/ui/card"
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

import { ErrorState } from "./event-shared"

const platformLabels = {
  ctfd: "CTFd",
  ret2shell: "Ret2Shell",
  a1ctf: "A1CTF",
  tsecbench: "TSecBench",
} as const

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
})

function EventDialog() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const form = useForm<EventInput>({ defaultValues: { name: "" } })
  const mutation = useMutation({
    mutationFn: (input: EventInput) => eventsApi.createEvent(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.events.all })
      setOpen(false)
      form.reset()
    },
  })

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      mutation.reset()
      form.reset()
    }
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger render={<Button type="button" />}>
        <Plus /> 创建赛事
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>创建赛事</DialogTitle>
          <DialogDescription>为题目和任务搭建一个工作区。</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={form.handleSubmit((values) =>
            mutation.mutate({ name: values.name.trim() })
          )}
        >
          <DialogPanel className="grid gap-4">
            <Field>
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
            {mutation.error && (
              <Alert variant="error">
                <TriangleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              创建赛事
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function EventCard({ event }: { event: EventSummary }) {
  const platformLabel = event.platform
    ? platformLabels[event.platform.type]
    : "本地"

  return (
    <CardFrame className="h-full min-w-0" render={<article />}>
      <Card className="flex-1">
        <CardPanel className="flex min-h-32 flex-col justify-center gap-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-base leading-5 font-semibold">
              <Link className="hover:underline" to={`/events/${event.id}`}>
                {event.name}
              </Link>
            </h2>
            <Badge variant="outline">{platformLabel}</Badge>
          </div>
          {event.platform ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted-foreground">进度</span>
                <span className="font-medium tabular-nums">
                  已解决 {event.solvedCount} / {event.challengeCount}
                </span>
              </div>
              <Progress
                aria-label={`已解决 ${event.solvedCount} / ${event.challengeCount} 个题目`}
                max={Math.max(event.challengeCount, 1)}
                value={event.solvedCount}
              />
            </div>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground">题目</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {event.challengeCount}
              </p>
            </div>
          )}
          {event.activeRunCount > 0 && (
            <Badge className="w-fit" variant="info">
              <Activity /> {event.activeRunCount} 个活跃任务
            </Badge>
          )}
        </CardPanel>
      </Card>
      <CardFrameFooter className="flex min-h-16 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Clock3 className="size-3.5 shrink-0" />
            更新于
            <time dateTime={event.lastActivityAt}>
              {dateTimeFormatter.format(new Date(event.lastActivityAt))}
            </time>
          </span>
          {event.platform && (
            <span className="flex items-center gap-1.5">
              <RefreshCw className="size-3.5 shrink-0" />
              {event.platform.credentialConfigured
                ? event.platform.lastSyncedAt
                  ? `已同步 ${dateTimeFormatter.format(new Date(event.platform.lastSyncedAt))}`
                  : "未同步"
                : "需要凭据"}
            </span>
          )}
        </div>
        <Button render={<Link to={`/events/${event.id}`} />} variant="ghost">
          打开 <ArrowRight />
        </Button>
      </CardFrameFooter>
    </CardFrame>
  )
}

export function HomePage() {
  const events = useQuery({
    queryKey: keys.events.all,
    queryFn: () => eventsApi.listEvents(),
  })

  return (
    <AppLayout>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">赛事</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理 CTF 工作区、题目与解题任务。
          </p>
        </div>
        <EventDialog />
      </div>

      {events.isPending && (
        <div
          className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner aria-hidden="true" />
          正在加载赛事…
        </div>
      )}
      {events.error && (
        <ErrorState error={events.error} retry={() => events.refetch()} />
      )}
      {events.data?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDays />
            </EmptyMedia>
            <EmptyTitle>暂无赛事</EmptyTitle>
            <EmptyDescription>创建赛事即可开始整理题目。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {events.data && events.data.items.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          {events.data.items.map((event) => (
            <EventCard event={event} key={event.id} />
          ))}
        </div>
      )}
    </AppLayout>
  )
}
