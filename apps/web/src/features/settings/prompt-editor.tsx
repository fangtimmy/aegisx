import { useMutation } from "@tanstack/react-query"
import { BookOpen, Braces, Eye } from "lucide-react"
import { useRef, useState } from "react"

import { settingsApi } from "@/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu"
import { Textarea } from "@/components/ui/textarea"

/** Preview context kinds the server supports (settings/prompt-templates.ts). */
export type PromptPreviewKind =
  | "mainSystemPrompt"
  | "initialPrompt"
  | "orchestratorSystemPrompt"

/** Prompt template editor: {{variable}} insertion, live preview (only kinds
 * with a server-side sample context) and a monospace textarea. Controlled;
 * saving/debouncing is the caller's. */
export function PromptEditor({
  title,
  kind,
  variables,
  value,
  onChange,
  disabled,
}: {
  title: string
  /** Preview context kind; omit to hide the preview button. */
  kind?: PromptPreviewKind
  variables: string[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const preview = useMutation({
    mutationFn: (template: string) =>
      settingsApi.previewPrompts({
        kind: kind ?? "mainSystemPrompt",
        template,
      }),
  })

  function insertVariable(variable: string) {
    const textarea = ref.current
    const start = textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? value.length
    const token = `{{${variable}}}`
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Menu>
          <MenuTrigger
            render={<Button type="button" variant="outline" size="sm" />}
          >
            <Braces /> 变量
          </MenuTrigger>
          <MenuPopup align="end" className="max-h-72">
            {variables.map((variable) => (
              <MenuItem key={variable} onClick={() => insertVariable(variable)}>
                <code>{`{{${variable}}}`}</code>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        {kind && (
          <Button
            disabled={disabled}
            loading={preview.isPending}
            onClick={() => {
              setPreviewOpen(true)
              preview.mutate(value)
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <Eye /> 预览
          </Button>
        )}
        <Dialog>
          <DialogTrigger
            render={<Button type="button" variant="ghost" size="sm" />}
          >
            <BookOpen /> 语法
          </DialogTrigger>
          <DialogPopup className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Handlebars 模板语法</DialogTitle>
              <DialogDescription>
                留空即保存为空（不回退到内置默认值）。使用「重置」可恢复默认模板。
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="text-sm">
              <p className="text-muted-foreground">
                使用「变量」菜单中的 {"{{variable}}"} 占位符。
              </p>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </div>
      <Textarea
        className="[&_textarea]:max-h-64 [&_textarea]:min-h-32 [&_textarea]:overflow-y-auto [&_textarea]:font-mono [&_textarea]:text-xs"
        disabled={disabled}
        maxLength={100_000}
        onChange={(event) => onChange(event.target.value)}
        ref={ref}
        value={value}
      />
      <Dialog
        onOpenChange={(open) => {
          setPreviewOpen(open)
          if (!open) preview.reset()
        }}
        open={previewOpen}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>预览：{title}</DialogTitle>
            <DialogDescription>带高亮替换内容的示例上下文。</DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[60vh] overflow-auto font-mono text-xs whitespace-pre-wrap">
            {preview.error && (
              <p className="text-destructive">{preview.error.message}</p>
            )}
            {preview.data?.segments.map((segment) => (
              <span
                className={segment.highlighted ? "bg-primary/20" : undefined}
                key={segment.id}
              >
                {segment.text}
              </span>
            ))}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
