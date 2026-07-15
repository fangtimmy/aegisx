import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  Brain,
  CircleAlert,
  Clock3,
  FileQuestion,
  ListTree,
  MessageSquare,
  Monitor,
  Pause,
  Play,
  Plus,
  Send,
  Square,
  Terminal,
  Wrench,
} from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { Challenge, RunPublic, RunStatus, SessionEntry } from "@/lib/api"
import { apiRequest, jsonRequest } from "@/lib/api"

const runKeys = {
  event: (eventId: string) => ["runs", "event", eventId] as const,
  detail: (runId: string) => ["runs", runId] as const,
}

const statuses: RunStatus[] = [
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (value === null || value === undefined) {
    return ""
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatTime(value: string | number | null | undefined) {
  if (!value) {
    return "Not available"
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value))
}

function statusVariant(status: RunStatus) {
  if (status === "completed") return "success" as const
  if (status === "failed") return "error" as const
  if (status === "paused") return "warning" as const
  return "secondary" as const
}

function messageKey(message: unknown) {
  if (!isRecord(message)) return null
  const role = text(message.role)
  const timestamp = text(message.timestamp)
  return role && timestamp ? `${role}:${timestamp}` : null
}

type TimelineItem = {
  key: string
  kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "result"
    | "error"
    | "system"
  label: string
  body: string
  timestamp?: string | number
}

function contentItems(
  content: unknown,
  key: string,
  role: string,
  timestamp?: string | number
): TimelineItem[] {
  const values = Array.isArray(content) ? content : [content]
  return values.flatMap<TimelineItem>((part, index) => {
    if (typeof part === "string") {
      return [
        {
          key: `${key}:${index}`,
          kind: role === "user" ? "user" : "assistant",
          label: role,
          body: part,
          timestamp,
        },
      ]
    }
    if (!isRecord(part)) return []
    if (part.type === "text") {
      return [
        {
          key: `${key}:${index}`,
          kind: role === "user" ? "user" : "assistant",
          label: role,
          body: text(part.text),
          timestamp,
        },
      ]
    }
    if (part.type === "thinking") {
      return [
        {
          key: `${key}:${index}`,
          kind: "thinking",
          label: "Thinking",
          body: text(part.thinking),
          timestamp,
        },
      ]
    }
    if (part.type === "toolCall") {
      return [
        {
          key: `${key}:${text(part.id) || index}`,
          kind: "tool",
          label: `Tool call · ${text(part.name) || "unknown"}`,
          body: text(part.arguments),
          timestamp,
        },
      ]
    }
    if (part.type === "image") {
      return [
        {
          key: `${key}:${index}`,
          kind: "system",
          label: "Image",
          body: text(part.mimeType) || "Image content",
          timestamp,
        },
      ]
    }
    return [
      {
        key: `${key}:${index}`,
        kind: "system",
        label: text(part.type) || role,
        body: text(part),
        timestamp,
      },
    ]
  })
}

function entryItems(entry: SessionEntry): TimelineItem[] {
  if (entry.type === "message" && isRecord(entry.message)) {
    const message = entry.message
    const role = text(message.role)
    const timestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : entry.timestamp
    if (role === "toolResult") {
      return [
        {
          key: entry.id,
          kind: message.isError ? "error" : "result",
          label: `${message.isError ? "Tool error" : "Tool result"} · ${text(message.toolName) || "unknown"}`,
          body:
            contentItems(message.content, entry.id, role, timestamp)
              .map((item) => item.body)
              .filter(Boolean)
              .join("\n") || text(message.details),
          timestamp,
        },
      ]
    }
    return contentItems(message.content, entry.id, role, timestamp)
  }
  if (entry.type === "model_change") {
    return [
      {
        key: entry.id,
        kind: "system",
        label: "Model changed",
        body: `${text(entry.provider)} / ${text(entry.modelId)}`,
        timestamp: entry.timestamp,
      },
    ]
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [
      {
        key: entry.id,
        kind: "system",
        label:
          entry.type === "compaction" ? "Context compacted" : "Branch summary",
        body: text(entry.summary),
        timestamp: entry.timestamp,
      },
    ]
  }
  return []
}

function liveItems(payload: Record<string, unknown>): TimelineItem[] {
  const type = text(payload.type)
  const message = isRecord(payload.message) ? payload.message : null
  if (
    (type === "message_start" ||
      type === "message_update" ||
      type === "message_end") &&
    message
  ) {
    const items = contentItems(
      message.content,
      messageKey(message) ?? type,
      text(message.role),
      typeof message.timestamp === "number" ? message.timestamp : undefined
    )
    return items
  }
  if (type.startsWith("tool_execution_")) {
    const ended = type === "tool_execution_end"
    return [
      {
        key: `tool:${text(payload.toolCallId)}`,
        kind: payload.isError ? "error" : ended ? "result" : "tool",
        label: `${ended ? (payload.isError ? "Tool error" : "Tool result") : "Running tool"} · ${text(payload.toolName) || "unknown"}`,
        body: text(
          ended ? payload.result : (payload.partialResult ?? payload.args)
        ),
      },
    ]
  }
  if (type.includes("error") || payload.error) {
    return [
      {
        key: `event:${type}`,
        kind: "error",
        label: "Run error",
        body: text(payload.error ?? payload.errorMessage ?? payload.message),
      },
    ]
  }
  return []
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const Icon =
    item.kind === "thinking"
      ? Brain
      : item.kind === "tool"
        ? Wrench
        : item.kind === "result"
          ? Terminal
          : item.kind === "error"
            ? CircleAlert
            : item.kind === "user"
              ? MessageSquare
              : item.kind === "assistant"
                ? Bot
                : Clock3
  return (
    <article className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 border-b py-3 last:border-b-0">
      <Icon className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="font-medium text-xs capitalize">{item.label}</h4>
          {item.timestamp && (
            <time className="text-[11px] text-muted-foreground">
              {formatTime(item.timestamp)}
            </time>
          )}
        </div>
        {item.body && (
          <pre className="mt-1.5 whitespace-pre-wrap break-words font-sans text-xs leading-5">
            {item.body}
          </pre>
        )}
      </div>
    </article>
  )
}

export function CreateRunDialog({
  challenges,
  challenge,
  trigger,
  onCreated,
}: {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  trigger?: ReactNode
  onCreated?: () => void
}) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({
      challengeId,
      provider,
      modelId,
    }: {
      challengeId: string
      provider: string
      modelId: string
    }) =>
      apiRequest<RunPublic>(
        `/challenges/${challengeId}/runs`,
        jsonRequest("POST", { provider, modelId })
      ),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({
        queryKey: runKeys.event(run.eventId),
      })
      setOpen(false)
      onCreated?.()
      navigate(`/events/${run.eventId}/runs/${run.id}`)
    },
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      challengeId: challenge?.id ?? String(data.get("challengeId")),
      provider: String(data.get("provider")).trim(),
      modelId: String(data.get("modelId")).trim(),
    })
  }

  const available = challenge ? [challenge] : (challenges ?? [])
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) mutation.reset()
      }}
    >
      <DialogTrigger
        aria-label={
          trigger && challenge ? `Start run for ${challenge.name}` : undefined
        }
        render={
          <Button
            disabled={available.length === 0}
            size={trigger ? "icon-xs" : undefined}
            type="button"
          />
        }
      >
        {trigger ?? (
          <>
            <Plus /> Start run
          </>
        )}
      </DialogTrigger>
      <DialogPopup className="sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>Start local run</DialogTitle>
          <DialogDescription>
            {challenge
              ? `Configure a run for ${challenge.name}.`
              : "Choose a challenge and model for this run."}
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={submit}>
          <DialogPanel className="grid gap-5">
            {!challenge && (
              <Field>
                <FieldLabel htmlFor="run-challenge">Challenge</FieldLabel>
                <select
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  defaultValue={available[0]?.id}
                  id="run-challenge"
                  name="challengeId"
                  required
                >
                  {available.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field>
              <FieldLabel>Provider</FieldLabel>
              <Input defaultValue="anthropic" name="provider" required />
            </Field>
            <Field>
              <FieldLabel>Model ID</FieldLabel>
              <Input defaultValue="claude-sonnet-4-5" name="modelId" required />
            </Field>
            <Alert className="rounded-lg" variant="warning">
              <Monitor />
              <AlertTitle>Local execution is not sandboxed</AlertTitle>
              <AlertDescription>
                The agent can access the local runtime and challenge workspace.
                Review the challenge before starting.
              </AlertDescription>
            </Alert>
            {mutation.error && (
              <p className="text-destructive-foreground text-sm" role="alert">
                {mutation.error.message}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button loading={mutation.isPending} type="submit">
              <Play /> Start run
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function RunTree({
  eventId,
  challenges,
  runs,
  runId,
  onSelect,
}: {
  eventId: string
  challenges: Challenge[]
  runs: RunPublic[]
  runId?: string
  onSelect?: () => void
}) {
  return (
    <nav aria-label="Event runs" className="space-y-4">
      {challenges.map((challenge) => {
        const challengeRuns = runs.filter(
          (run) => run.challengeId === challenge.id
        )
        return (
          <section key={challenge.id}>
            <div className="flex items-center justify-between gap-2 px-2">
              <h3 className="truncate font-medium text-xs">{challenge.name}</h3>
              <CreateRunDialog
                challenge={challenge}
                onCreated={onSelect}
                trigger={
                  <Plus aria-label={`Start run for ${challenge.name}`} />
                }
              />
            </div>
            <div className="mt-1 space-y-0.5">
              {challengeRuns.length === 0 && (
                <p className="px-2 py-1 text-muted-foreground text-xs">
                  No runs
                </p>
              )}
              {challengeRuns.map((run) => (
                <Button
                  className="h-auto w-full justify-start px-2 py-1.5 text-left"
                  key={run.id}
                  onClick={onSelect}
                  render={<Link to={`/events/${eventId}/runs/${run.id}`} />}
                  variant={run.id === runId ? "secondary" : "ghost"}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">
                      {run.modelId}
                    </span>
                    <span className="block capitalize text-[11px] text-muted-foreground">
                      {run.status}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </section>
        )
      })}
    </nav>
  )
}

function RunOverview({ run }: { run: RunPublic }) {
  return (
    <div className="space-y-5 py-4">
      <Alert className="rounded-lg" variant="warning">
        <Monitor />
        <AlertTitle>Local environment</AlertTitle>
        <AlertDescription>
          This run is executing without a sandbox. Local files and processes may
          be accessible to the agent.
        </AlertDescription>
      </Alert>
      <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground text-xs">Status</dt>
          <dd className="mt-1">
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Model</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {run.provider} / {run.modelId}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Started</dt>
          <dd className="mt-1">{formatTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Completed</dt>
          <dd className="mt-1">{formatTime(run.completedAt)}</dd>
        </div>
      </dl>
      {(run.summary || run.flag) && (
        <section className="border-t pt-4">
          <h3 className="font-medium text-sm">Result</h3>
          {run.summary && (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
              {run.summary}
            </p>
          )}
          {run.flag && (
            <p className="mt-2 break-all font-mono text-xs">Flag: {run.flag}</p>
          )}
        </section>
      )}
      {run.error && (
        <Alert className="rounded-lg" variant="error">
          <CircleAlert />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {run.error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function Conversation({
  history,
  live,
}: {
  history: SessionEntry[]
  live: TimelineItem[]
}) {
  const persistedKeys = history.flatMap((entry) => {
    if (entry.type !== "message" || !isRecord(entry.message)) return []
    const key = messageKey(entry.message)
    const toolKey = text(entry.message.toolCallId)
    return [key, toolKey ? `tool:${toolKey}` : null].filter(Boolean) as string[]
  })
  const items = [
    ...history.flatMap(entryItems),
    ...live.filter(
      (item) =>
        !persistedKeys.some(
          (key) => item.key === key || item.key.startsWith(`${key}:`)
        )
    ),
  ]
  if (items.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyTitle>No conversation yet</EmptyTitle>
          <EmptyDescription>
            Agent output and tool activity will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div aria-live="polite">
      {items.map((item) => (
        <TimelineRow item={item} key={item.key} />
      ))}
    </div>
  )
}

function RunWorkspace({
  eventId,
  runId,
  challenges,
}: {
  eventId: string
  runId?: string
  challenges: Challenge[]
}) {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [draft, setDraft] = useState("")
  const [live, setLive] = useState<TimelineItem[]>([])
  const detail = useQuery({
    enabled: Boolean(runId),
    queryKey: runKeys.detail(runId ?? ""),
    queryFn: () =>
      apiRequest<{ run: RunPublic; history: SessionEntry[] }>(`/runs/${runId}`),
  })
  const control = useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: "message" | "pause" | "resume" | "stop"
      body: object
    }) =>
      apiRequest<void>(`/runs/${runId}/${action}`, jsonRequest("POST", body)),
    onSuccess: async (_, variables) => {
      if (variables.action === "message" || variables.action === "resume") {
        setDraft("")
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: runKeys.detail(runId ?? ""),
        }),
        queryClient.invalidateQueries({ queryKey: runKeys.event(eventId) }),
      ])
    },
  })

  useEffect(() => {
    setLive([])
    if (!runId) return
    const source = new EventSource(`/api/runs/${runId}/events`)
    source.onmessage = (event) => {
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        payload = { type: "error", error: event.data }
      }
      if (!isRecord(payload)) return
      const items = liveItems(payload)
      if (items.length > 0) {
        const keys = new Set(items.map((item) => item.key))
        setLive((current) => [
          ...current.filter((value) => !keys.has(value.key)),
          ...items,
        ])
      }
      const status = text(
        payload.status ??
          (isRecord(payload.run) ? payload.run.status : undefined)
      )
      if (statuses.includes(status as RunStatus)) {
        queryClient.setQueryData<{ run: RunPublic; history: SessionEntry[] }>(
          runKeys.detail(runId),
          (current) =>
            current
              ? {
                  ...current,
                  run: { ...current.run, status: status as RunStatus },
                }
              : current
        )
      }
      if (
        payload.type === "entry_appended" ||
        payload.type === "message_end" ||
        statuses.includes(status as RunStatus)
      ) {
        queryClient.invalidateQueries({ queryKey: runKeys.detail(runId) })
        queryClient.invalidateQueries({ queryKey: runKeys.event(eventId) })
      }
    }
    return () => source.close()
  }, [eventId, queryClient, runId])

  if (!runId) {
    return (
      <div className="flex min-h-96 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Select a run</EmptyTitle>
            <EmptyDescription>
              Open an existing run or start a new local run.
            </EmptyDescription>
          </EmptyHeader>
          <CreateRunDialog challenges={challenges} />
        </Empty>
      </div>
    )
  }
  if (detail.isPending)
    return <p className="p-6 text-muted-foreground text-sm">Loading run...</p>
  if (detail.error)
    return (
      <Alert className="m-4 w-auto rounded-lg" variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load run</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    )
  if (!detail.data) return null
  const { run, history } = detail.data
  const active = run.status === "running" || run.status === "paused"
  const canMessage = run.status === "running"

  function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (message) control.mutate({ action: "message", body: { message } })
  }

  return (
    <div className="flex min-h-[36rem] min-w-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold text-base">
              {run.challengeName}
            </h2>
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </div>
          <p className="mt-1 truncate font-mono text-muted-foreground text-xs">
            {run.provider} / {run.modelId}
          </p>
        </div>
        <CreateRunDialog
          challenge={{ id: run.challengeId, name: run.challengeName }}
        />
      </header>
      <Tabs
        className="min-h-0 flex-1 px-4 pt-2"
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("view", value)
          setSearchParams(next, { replace: true })
        }}
        value={
          searchParams.get("view") === "overview" ? "overview" : "conversation"
        }
      >
        <TabsList className="w-full justify-start border-b" variant="underline">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="conversation">Conversation</TabsTab>
          <TabsTab disabled value="files">
            Files
          </TabsTab>
        </TabsList>
        <TabsPanel value="overview">
          <RunOverview run={run} />
        </TabsPanel>
        <TabsPanel className="min-h-0" value="conversation">
          <ScrollArea className="h-[min(52vh,34rem)]">
            <Conversation history={history} live={live} />
          </ScrollArea>
        </TabsPanel>
        <TabsPanel value="files">
          <FileQuestion />
        </TabsPanel>
      </Tabs>
      <div className="border-t bg-muted/20 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {run.status === "running" && (
            <Button
              loading={
                control.isPending && control.variables?.action === "pause"
              }
              onClick={() => control.mutate({ action: "pause", body: {} })}
              size="sm"
              variant="outline"
            >
              <Pause /> Pause
            </Button>
          )}
          {run.status === "paused" && (
            <Button
              loading={
                control.isPending && control.variables?.action === "resume"
              }
              onClick={() =>
                control.mutate({
                  action: "resume",
                  body: { message: draft.trim() || undefined },
                })
              }
              size="sm"
              variant="outline"
            >
              <Play /> Resume
            </Button>
          )}
          {active && (
            <Button
              loading={
                control.isPending && control.variables?.action === "stop"
              }
              onClick={() => control.mutate({ action: "stop", body: {} })}
              size="sm"
              variant="destructive-outline"
            >
              <Square /> Stop
            </Button>
          )}
          <span className="ml-auto text-muted-foreground text-xs" role="status">
            Run is {run.status}
            {control.isPending ? ` · ${control.variables?.action} pending` : ""}
          </span>
        </div>
        <form className="flex items-end gap-2" onSubmit={send}>
          <Field className="min-w-0 flex-1">
            <FieldLabel className="sr-only" htmlFor="run-message">
              Message to agent
            </FieldLabel>
            <Textarea
              className="min-h-0"
              disabled={!active || control.isPending}
              id="run-message"
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                run.status === "paused"
                  ? "Optional guidance when resuming"
                  : active
                    ? "Send guidance to the agent"
                    : `Messaging unavailable while ${run.status}`
              }
              rows={2}
              size="sm"
              value={draft}
            />
          </Field>
          <Button
            aria-label="Send message"
            disabled={!canMessage || !draft.trim()}
            loading={
              control.isPending && control.variables?.action === "message"
            }
            size="icon"
            type="submit"
          >
            <Send />
          </Button>
        </form>
        {control.error && (
          <p className="mt-2 text-destructive-foreground text-xs" role="alert">
            {control.error.message}
          </p>
        )}
      </div>
    </div>
  )
}

export function RunsView({
  eventId,
  challenges,
  runId,
}: {
  eventId: string
  challenges: Challenge[]
  runId?: string
}) {
  const [treeOpen, setTreeOpen] = useState(false)
  const runs = useQuery({
    queryKey: runKeys.event(eventId),
    queryFn: () =>
      apiRequest<{ items: RunPublic[] }>(`/events/${eventId}/runs`),
  })
  if (runs.isPending)
    return (
      <p className="py-16 text-center text-muted-foreground text-sm">
        Loading runs...
      </p>
    )
  if (runs.error)
    return (
      <Alert className="rounded-lg" variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load runs</AlertTitle>
        <AlertDescription>{runs.error.message}</AlertDescription>
      </Alert>
    )
  return (
    <div className="mt-4 overflow-hidden rounded-md border bg-card lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="hidden border-r bg-muted/20 p-3 lg:block">
        <div className="mb-4 flex items-center gap-2 px-2">
          <ListTree className="size-4" />
          <h2 className="font-medium text-sm">Runs</h2>
        </div>
        <RunTree
          challenges={challenges}
          eventId={eventId}
          runId={runId}
          runs={runs.data.items}
        />
      </aside>
      <div className="border-b p-3 lg:hidden">
        <Sheet onOpenChange={setTreeOpen} open={treeOpen}>
          <SheetTrigger render={<Button type="button" variant="outline" />}>
            <ListTree /> Browse runs
          </SheetTrigger>
          <SheetPopup className="max-w-xs" side="left">
            <SheetHeader>
              <SheetTitle>Runs</SheetTitle>
              <SheetDescription>Runs grouped by challenge</SheetDescription>
            </SheetHeader>
            <SheetPanel>
              <RunTree
                challenges={challenges}
                eventId={eventId}
                onSelect={() => setTreeOpen(false)}
                runId={runId}
                runs={runs.data.items}
              />
            </SheetPanel>
          </SheetPopup>
        </Sheet>
      </div>
      <RunWorkspace challenges={challenges} eventId={eventId} runId={runId} />
    </div>
  )
}
