import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  BookOpen,
  Braces,
  CircleAlert,
  Eye,
  RotateCcw,
  Save,
} from "lucide-react"
import { type RefObject, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { apiRequest, jsonRequest, type SettingsPublic } from "@/lib/api"

type PromptTemplates = Pick<
  SettingsPublic,
  | "mainSystemPromptTemplate"
  | "childSystemPromptTemplate"
  | "initialPromptTemplate"
>

type PromptKind = "mainSystemPrompt" | "childSystemPrompt" | "initialPrompt"

type PromptPreviewSegment = {
  id: number
  text: string
  highlighted: boolean
}

type PromptPreview = {
  segments: PromptPreviewSegment[]
}

function insertVariable(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  variable: string,
  setValue: (value: string) => void
) {
  const textarea = ref.current
  const start = textarea?.selectionStart ?? value.length
  const end = textarea?.selectionEnd ?? value.length
  const token = `{{${variable}}}`
  setValue(`${value.slice(0, start)}${token}${value.slice(end)}`)
  requestAnimationFrame(() => {
    textarea?.focus()
    textarea?.setSelectionRange(start + token.length, start + token.length)
  })
}

function VariableMenu({
  variables,
  onSelect,
}: {
  variables: string[]
  onSelect: (variable: string) => void
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button type="button" variant="outline" />}>
        <Braces /> Variables
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-72">
        {variables.map((variable) => (
          <MenuItem key={variable} onClick={() => onSelect(variable)}>
            <code>{`{{${variable}}}`}</code>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  )
}

function PromptEditor({
  description,
  id,
  loading,
  onChange,
  onPreview,
  onVariable,
  ref,
  title,
  value,
  variables,
}: {
  description: string
  id: string
  loading: boolean
  onChange: (value: string) => void
  onPreview: () => void
  onVariable: (variable: string) => void
  ref: RefObject<HTMLTextAreaElement | null>
  title: string
  value: string
  variables: string[]
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium text-sm">{title}</h2>
          <p className="mt-1 text-muted-foreground text-sm">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <VariableMenu onSelect={onVariable} variables={variables} />
          <Button
            loading={loading}
            onClick={onPreview}
            type="button"
            variant="outline"
          >
            <Eye /> Preview
          </Button>
        </div>
      </div>
      <Field>
        <FieldLabel className="sr-only" htmlFor={id}>
          {title}
        </FieldLabel>
        <Textarea
          className="[&_textarea]:min-h-64 [&_textarea]:font-mono [&_textarea]:text-xs"
          id={id}
          maxLength={100_000}
          onChange={(event) => onChange(event.target.value)}
          ref={ref}
          value={value}
        />
      </Field>
    </section>
  )
}

const previewTitles: Record<PromptKind, string> = {
  mainSystemPrompt: "Main Agent system prompt",
  childSystemPrompt: "Child Agent system prompt",
  initialPrompt: "Initial user prompt",
}

const variableGroups = [
  "agent",
  "event",
  "challenge",
  "model",
  "run",
  "capabilities",
] as const

export function PromptSettings({ settings }: { settings: SettingsPublic }) {
  const queryClient = useQueryClient()
  const mainSystemRef = useRef<HTMLTextAreaElement>(null)
  const childSystemRef = useRef<HTMLTextAreaElement>(null)
  const initialRef = useRef<HTMLTextAreaElement>(null)
  const [mainSystemPromptTemplate, setMainSystemPromptTemplate] = useState(
    settings.mainSystemPromptTemplate
  )
  const [childSystemPromptTemplate, setChildSystemPromptTemplate] = useState(
    settings.childSystemPromptTemplate
  )
  const [initialPromptTemplate, setInitialPromptTemplate] = useState(
    settings.initialPromptTemplate
  )
  const [previewKind, setPreviewKind] = useState<PromptKind | null>(null)
  const templates = {
    mainSystemPromptTemplate,
    childSystemPromptTemplate,
    initialPromptTemplate,
  }
  const save = useMutation({
    mutationFn: (input: PromptTemplates) =>
      apiRequest<SettingsPublic>(
        "/settings/prompts",
        jsonRequest("PATCH", input)
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  })
  const preview = useMutation({
    mutationFn: (input: { kind: PromptKind; template: string }) =>
      apiRequest<PromptPreview>(
        "/settings/prompts/preview",
        jsonRequest("POST", input)
      ),
  })
  const openPreview = (kind: PromptKind, template: string) => {
    preview.reset()
    setPreviewKind(kind)
    preview.mutate({ kind, template })
  }
  const previewSegments = preview.data?.segments

  return (
    <div className="flex flex-col gap-6">
      <PromptEditor
        description="Rendered for the Main Agent responsible for completing the Run."
        id="main-system-prompt-template"
        loading={preview.isPending && previewKind === "mainSystemPrompt"}
        onChange={setMainSystemPromptTemplate}
        onPreview={() =>
          openPreview("mainSystemPrompt", mainSystemPromptTemplate)
        }
        onVariable={(variable) =>
          insertVariable(
            mainSystemRef,
            mainSystemPromptTemplate,
            variable,
            setMainSystemPromptTemplate
          )
        }
        ref={mainSystemRef}
        title="Main Agent system prompt template"
        value={mainSystemPromptTemplate}
        variables={settings.promptTemplateVariables}
      />

      <div className="border-t pt-6">
        <PromptEditor
          description="Rendered for background Agents working on delegated tasks."
          id="child-system-prompt-template"
          loading={preview.isPending && previewKind === "childSystemPrompt"}
          onChange={setChildSystemPromptTemplate}
          onPreview={() =>
            openPreview("childSystemPrompt", childSystemPromptTemplate)
          }
          onVariable={(variable) =>
            insertVariable(
              childSystemRef,
              childSystemPromptTemplate,
              variable,
              setChildSystemPromptTemplate
            )
          }
          ref={childSystemRef}
          title="Child Agent system prompt template"
          value={childSystemPromptTemplate}
          variables={settings.promptTemplateVariables}
        />
      </div>

      <div className="border-t pt-6">
        <PromptEditor
          description="Sent to the Main Agent when a new Run starts."
          id="initial-prompt-template"
          loading={preview.isPending && previewKind === "initialPrompt"}
          onChange={setInitialPromptTemplate}
          onPreview={() => openPreview("initialPrompt", initialPromptTemplate)}
          onVariable={(variable) =>
            insertVariable(
              initialRef,
              initialPromptTemplate,
              variable,
              setInitialPromptTemplate
            )
          }
          ref={initialRef}
          title="Initial user prompt template"
          value={initialPromptTemplate}
          variables={settings.promptTemplateVariables}
        />
      </div>

      {save.error && (
        <Alert variant="error">
          <CircleAlert />
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-2">
        <Dialog>
          <DialogTrigger render={<Button type="button" variant="ghost" />}>
            <BookOpen /> Syntax
          </DialogTrigger>
          <DialogPopup className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Handlebars template syntax</DialogTitle>
              <DialogDescription>
                Templates use strict Handlebars syntax. Unknown variables cause
                a validation error.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4 text-sm">
              <div>
                <h3 className="mb-2 font-medium">Available variables</h3>
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  {variableGroups.map((group) => (
                    <div key={group}>
                      <h4 className="mb-1 font-medium text-muted-foreground text-xs capitalize">
                        {group}
                      </h4>
                      <div className="grid grid-cols-2 gap-1">
                        {settings.promptTemplateVariables
                          .filter((variable) =>
                            variable.startsWith(`${group}.`)
                          )
                          .map((variable) => (
                            <code className="text-xs" key={variable}>
                              {`{{${variable}}}`}
                            </code>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="mb-1 font-medium">Attachment item variables</h3>
                <p className="text-muted-foreground text-sm">
                  Inside a <code>{"{{#each challenge.attachments}}"}</code>
                  block, use <code>{"{{name}}"}</code>,{" "}
                  <code>{"{{path}}"}</code>, and <code>{"{{size}}"}</code>.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-medium">Variable</h3>
                <pre className="rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                  {"{{challenge.name}}"}
                </pre>
              </div>
              <div>
                <h3 className="mb-1 font-medium">Conditional</h3>
                <pre className="rounded-lg border bg-muted/30 p-3 whitespace-pre-wrap font-mono text-xs">
                  {
                    "{{#if challenge.category}}\nCategory: {{challenge.category}}\n{{else}}\nNo category\n{{/if}}"
                  }
                </pre>
              </div>
              <div>
                <h3 className="mb-1 font-medium">Loop</h3>
                <pre className="rounded-lg border bg-muted/30 p-3 whitespace-pre-wrap font-mono text-xs">
                  {
                    "{{#each challenge.attachments}}\n- {{name}} ({{size}} bytes, {{path}})\n{{/each}}"
                  }
                </pre>
              </div>
              <div>
                <h3 className="mb-1 font-medium">Join helper</h3>
                <pre className="rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                  {'{{join challenge.attachmentPaths ", "}}'}
                </pre>
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setMainSystemPromptTemplate(
                settings.defaultMainSystemPromptTemplate
              )
              setChildSystemPromptTemplate(
                settings.defaultChildSystemPromptTemplate
              )
              setInitialPromptTemplate(settings.defaultInitialPromptTemplate)
              preview.reset()
            }}
            type="button"
            variant="ghost"
          >
            <RotateCcw /> Reset to default
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => save.mutate(templates)}
            type="button"
          >
            <Save /> Save prompts
          </Button>
        </div>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setPreviewKind(null)
        }}
        open={previewKind !== null}
      >
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {previewKind ? previewTitles[previewKind] : "Prompt preview"}
            </DialogTitle>
            <DialogDescription>
              Rendered with sample Run data. Highlighted text comes from
              template variables.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {preview.isPending && (
              <div
                className="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm"
                role="status"
              >
                <Spinner /> Rendering preview...
              </div>
            )}
            {preview.error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{preview.error.message}</AlertDescription>
              </Alert>
            )}
            {previewSegments && (
              <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-4 whitespace-pre-wrap font-mono text-xs leading-5">
                {previewSegments.map((segment) =>
                  segment.highlighted ? (
                    <mark
                      className="rounded-sm bg-warning/24 text-foreground"
                      key={segment.id}
                    >
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={segment.id}>{segment.text}</span>
                  )
                )}
              </pre>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
