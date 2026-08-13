import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RotateCcw } from "lucide-react"
import { useMemo, useRef, useState } from "react"

import {
  keys,
  orchestrationsApi,
  type PromptTemplateRow,
  promptTemplatesApi,
  settingsApi,
} from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import { PromptEditor, type PromptPreviewKind } from "./prompt-editor"

const PLUGIN_LABELS: Record<string, string> = {
  builtin: "内置模板",
}

/** Human titles for known template keys; unknown keys fall back to the key. */
const TEMPLATE_META: Record<string, { title: string; description?: string }> = {
  mainSystem: {
    title: "主系统提示词",
    description: "solver agent 的系统提示词。",
  },
  childSystem: {
    title: "子系统提示词",
    description: "spawn 子 agent 的系统提示词（capabilities 清零）。",
  },
  initial: {
    title: "初始提示词",
    description: "新建 run 的首轮引导消息；入队时 queue.prompt 覆盖它。",
  },
  orchestratorSystem: {
    title: "编排器系统提示词",
    description: "scheduler 编排 run 的调度者 agent。",
  },
  observerSystem: {
    title: "观察者系统提示词",
    description: "observer-solver 编排的监督 agent。",
  },
  bootstrapSystem: {
    title: "探测系统提示词",
    description: "bootstrap-solver 编排的探测 agent。",
  },
  trioSystem: {
    title: "对等求解系统提示词",
    description: "trio 编排的对等 solver agent。",
  },
}

/** Preview kinds exist for the four builtin templates only (server preview
 * contexts are challenge/orchestrator-scoped). */
const BUILTIN_PREVIEW_KIND: Record<string, PromptPreviewKind> = {
  mainSystem: "mainSystemPrompt",
  childSystem: "childSystemPrompt",
  initial: "initialPrompt",
  orchestratorSystem: "orchestratorSystemPrompt",
}

/** Orchestrator-context templates (event + instruction vars); the scheduler's
 * `initial` override renders against the event context too. */
function isOrchestratorContext(plugin: string, key: string): boolean {
  return (
    key === "orchestratorSystem" ||
    (plugin === "scheduler" && key === "initial")
  )
}

const rowKey = (plugin: string, key: string) => `${plugin}\u0000${key}`

function TemplateRowEditor({
  row,
  defaultBody,
  variables,
  previewKind,
}: {
  row: PromptTemplateRow
  defaultBody: string
  variables: string[]
  previewKind?: PromptPreviewKind
}) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(row.body)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useMutation({
    mutationFn: (body: string) =>
      promptTemplatesApi.updateTemplate({
        plugin: row.plugin,
        key: row.key,
        body,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(keys.promptTemplates.all, response)
    },
    onError: (error) => toast.error("保存提示词模板失败", error.message),
  })

  const meta = TEMPLATE_META[row.key] ?? { title: row.key }
  const modified = value !== defaultBody

  function scheduleSave(next: string) {
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      save.mutate(next)
    }, 400)
  }

  return (
    <div className="grid grid-cols-[2px_minmax(0,1fr)_1.75rem] items-start gap-x-3 gap-y-1.5 py-2 pr-2">
      <div
        aria-hidden
        className={cn(
          "min-h-7 self-stretch rounded-e-sm",
          modified ? "bg-primary" : "bg-transparent"
        )}
      />
      <div className="min-w-0">
        <div className="text-sm leading-7 font-medium">{meta.title}</div>
        {meta.description && (
          <p className="text-xs leading-snug text-muted-foreground">
            {meta.description}
          </p>
        )}
        <code className="block text-[11px] leading-snug text-muted-foreground">
          {row.plugin} / {row.key}
        </code>
      </div>
      <div className="flex size-7 shrink-0 items-center justify-center">
        {modified ? (
          <Button
            aria-label="重置为默认"
            className="size-7"
            disabled={save.isPending}
            onClick={() => scheduleSave(defaultBody)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : (
          <span aria-hidden className="size-7" />
        )}
      </div>
      <div className="col-span-2 col-start-2 min-w-0">
        <PromptEditor
          disabled={save.isPending}
          kind={previewKind}
          onChange={scheduleSave}
          title={meta.title}
          value={value}
          variables={variables}
        />
      </div>
    </div>
  )
}

/** Settings-page「提示词模板」tab (spec §3.6): every prompt_templates row,
 * grouped by plugin, edited directly against GET/PATCH /api/prompt-templates.
 * FlatSettings no longer carries prompts — this store is the single source. */
export function PromptTemplatesPanel() {
  const templates = useQuery({
    queryKey: keys.promptTemplates.all,
    queryFn: () => promptTemplatesApi.listTemplates(),
  })
  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })
  const orchestrations = useQuery({
    queryKey: keys.orchestrations.all,
    queryFn: () => orchestrationsApi.listOrchestrations(),
  })

  /** Default bodies: builtin from /api/settings meta; plugin-declared from
   * /api/orchestrations templates. Reset source per row. */
  const defaultsByRow = useMemo(() => {
    const map = new Map<string, string>()
    const builtin = settings.data?.meta.promptTemplateDefaults
    if (builtin) {
      for (const [key, body] of Object.entries(builtin)) {
        map.set(rowKey("builtin", key), body)
      }
    }
    for (const plugin of orchestrations.data?.items ?? []) {
      for (const [key, body] of Object.entries(plugin.templates)) {
        map.set(rowKey(plugin.id, key), body)
      }
    }
    return map
  }, [settings.data, orchestrations.data])

  /** Group rows by plugin, builtin first, then by plugin id. */
  const groups = useMemo(() => {
    const byPlugin = new Map<string, PromptTemplateRow[]>()
    for (const row of templates.data?.items ?? []) {
      const list = byPlugin.get(row.plugin) ?? []
      list.push(row)
      byPlugin.set(row.plugin, list)
    }
    return [...byPlugin.entries()].sort((a, b) => {
      if (a[0] === "builtin") return -1
      if (b[0] === "builtin") return 1
      return a[0].localeCompare(b[0])
    })
  }, [templates.data])

  if (templates.isPending || settings.isPending || orchestrations.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载提示词模板…
      </div>
    )
  }
  const error = templates.error ?? settings.error ?? orchestrations.error
  if (error) {
    return (
      <Alert variant="error">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  const variables = settings.data!.meta
  return (
    <CardFrame className="min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>提示词模板</CardFrameTitle>
        <CardFrameDescription>
          按插件分组编辑，留空即保存为空（不回退默认）。改动即时保存，对新任务生效。
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel>
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无提示词模板。</p>
          )}
          {groups.map(([plugin, rows]) => (
            <section className="mb-6 last:mb-0" key={plugin}>
              <h2 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {PLUGIN_LABELS[plugin] ?? plugin}
              </h2>
              <div className="divide-y overflow-hidden rounded-lg border">
                {rows.map((row) => (
                  <TemplateRowEditor
                    defaultBody={
                      defaultsByRow.get(rowKey(row.plugin, row.key)) ?? ""
                    }
                    key={rowKey(row.plugin, row.key)}
                    previewKind={
                      row.plugin === "builtin"
                        ? BUILTIN_PREVIEW_KIND[row.key]
                        : undefined
                    }
                    row={row}
                    variables={
                      isOrchestratorContext(row.plugin, row.key)
                        ? variables.orchestratorPromptVariables
                        : variables.promptVariables
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </CardPanel>
      </Card>
    </CardFrame>
  )
}
