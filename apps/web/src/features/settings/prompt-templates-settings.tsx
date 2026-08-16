import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileText, RotateCcw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import {
  keys,
  type PromptTemplateRow,
  promptTemplatesApi,
  settingsApi,
} from "@/api"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/lib/toast"

import { PromptEditor, type PromptPreviewKind } from "./prompt-editor"

/** The four builtin template keys (v9: the plugin namespace is gone).
 * Unknown keys returned by the server fall back to the raw key. */
const TEMPLATE_META: Record<string, { title: string; description: string }> = {
  mainSystem: {
    title: "主系统提示词",
    description: "所有 solver 共用的系统提示词。",
  },
  initial: {
    title: "初始提示词",
    description:
      "challenge run 的首轮引导消息；run 级 strategy 与 solver 专属提示词追加进 Strategy 段。",
  },
  orchestratorSystem: {
    title: "调度者系统提示词",
    description: "event 域调度者 agent 的系统提示词。",
  },
  schedulerInitial: {
    title: "调度者初始提示词",
    description: "调度者 run 启动时的首轮引导消息。",
  },
}

/** Preview kinds the server has a sample context for; schedulerInitial has
 * none, so its preview button stays hidden. */
const BUILTIN_PREVIEW_KIND: Record<string, PromptPreviewKind> = {
  mainSystem: "mainSystemPrompt",
  initial: "initialPrompt",
  orchestratorSystem: "orchestratorSystemPrompt",
}

/** Templates rendered against the orchestrator (event) context. */
const ORCHESTRATOR_CONTEXT_KEYS = new Set([
  "orchestratorSystem",
  "schedulerInitial",
])

/** Settings-page prompt-templates panel (v9: flat four builtin keys — no
 * plugin grouping). Each row opens an editor dialog with debounced save +
 * reset-to-default. */
export function PromptTemplatesSettings() {
  const templates = useQuery({
    queryKey: keys.promptTemplates.all,
    queryFn: () => promptTemplatesApi.listTemplates(),
  })
  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })

  if (templates.isPending || settings.isPending) {
    return (
      <CardFrame className="min-w-0">
        <CardPanel>
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner aria-hidden="true" />
            正在加载提示词模板…
          </div>
        </CardPanel>
      </CardFrame>
    )
  }
  const error = templates.error ?? settings.error
  if (error) {
    return (
      <CardFrame className="min-w-0">
        <CardPanel className="text-sm text-destructive">
          {error.message}
        </CardPanel>
      </CardFrame>
    )
  }

  const defaults = settings.data!.meta.promptTemplateDefaults
  const variables = settings.data!.meta
  const rows = templates.data!.items
  return (
    <CardFrame className="min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>提示词模板</CardFrameTitle>
        <CardFrameDescription>
          内置提示词模板；改动即时保存，对新任务生效。
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="p-0">
          <div className="divide-y">
            {Object.keys(TEMPLATE_META).map((key) => (
              <PromptTemplateRow
                defaultBody={defaults[key as keyof typeof defaults] ?? ""}
                key={key}
                orchestratorVars={variables.orchestratorPromptVariables}
                promptVars={variables.promptVariables}
                row={rows.find((r) => r.plugin === "builtin" && r.key === key)}
                templateKey={key}
              />
            ))}
          </div>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** One prompt-template row: title + modified marker + an edit button that opens
 * a dialog with the full {@link PromptEditor} (debounced save + reset). */
function PromptTemplateRow({
  row,
  templateKey,
  defaultBody,
  promptVars,
  orchestratorVars,
}: {
  row: PromptTemplateRow | undefined
  templateKey: string
  defaultBody: string
  promptVars: string[]
  orchestratorVars: string[]
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const meta = TEMPLATE_META[templateKey] ?? {
    title: templateKey,
    description: "",
  }
  const [value, setValue] = useState(row?.body ?? defaultBody)

  // Re-seed the local draft whenever the row/default it tracks changes and the
  // dialog is closed (avoids clobbering in-flight edits).
  const tracked = row?.body ?? defaultBody
  useEffect(() => {
    if (!open) setValue(tracked)
  }, [tracked, open])

  const save = useMutation({
    mutationFn: (body: string) =>
      promptTemplatesApi.updateTemplate({
        plugin: "builtin",
        key: templateKey,
        body,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(keys.promptTemplates.all, response)
    },
    onError: (error) => toast.error("保存提示词模板失败", error.message),
  })

  const vars = useMemo(
    () =>
      ORCHESTRATOR_CONTEXT_KEYS.has(templateKey)
        ? orchestratorVars
        : promptVars,
    [templateKey, orchestratorVars, promptVars]
  )
  const modified = value !== defaultBody

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div
        aria-hidden
        className={`min-h-7 self-stretch rounded-e-sm ${modified ? "bg-primary" : "bg-transparent"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{meta.title}</div>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
        <code className="text-[11px] text-muted-foreground">
          builtin / {templateKey}
        </code>
      </div>
      <Dialog onOpenChange={setOpen} open={open}>
        <Button
          onClick={() => setOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <FileText /> 编辑
        </Button>
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{meta.title}</DialogTitle>
            <DialogDescription>
              留空即保存为空（不回退默认）。改动即时保存，对新任务生效。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <PromptEditor
              kind={BUILTIN_PREVIEW_KIND[templateKey]}
              onChange={(next) => {
                setValue(next)
                save.mutate(next)
              }}
              title={meta.title}
              value={value}
              variables={vars}
            />
            <div className="mt-2 flex items-center justify-between">
              <code className="text-[11px] text-muted-foreground">
                builtin / {templateKey}
              </code>
              {modified && (
                <Button
                  disabled={save.isPending}
                  onClick={() => {
                    setValue(defaultBody)
                    save.mutate(defaultBody)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" /> 重置为默认
                </Button>
              )}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
