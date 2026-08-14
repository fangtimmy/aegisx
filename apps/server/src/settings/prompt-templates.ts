import type { PromptTemplateContext } from "@aegisx/shared"
import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
} from "@aegisx/shared/prompt-defaults"
import Handlebars from "handlebars"

export {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
}

export const PROMPT_TEMPLATE_VARIABLES = [
  "agent.role",
  "agent.isMain",
  "agent.name",
  "agent.task",
  "event.id",
  "event.name",
  "event.platform",
  "challenge.id",
  "challenge.name",
  "challenge.description",
  "challenge.category",
  "challenge.points",
  "challenge.attachments",
  "challenge.attachmentPaths",
  "model.provider",
  "model.name",
  "model.id",
  "run.id",
  "run.environment",
  "run.isContainer",
  "run.workspace",
  "run.targetSupported",
  "run.platformIntegrated",
  "run.containerImage",
  "run.cpus",
  "run.memoryMb",
  "run.pidsLimit",
  "capabilities.canFinish",
  "capabilities.canSpawn",
  "capabilities.canSubmitFlag",
  "capabilities.canManageTarget",
] as const

export type PromptPreviewSegment = {
  id: number
  text: string
  highlighted: boolean
}

const handlebars = Handlebars.create()
handlebars.registerHelper("join", (values: unknown, separator: unknown) =>
  Array.isArray(values) ? values.join(String(separator)) : ""
)

export const samplePromptContext: PromptTemplateContext = {
  agent: {
    role: "main",
    isMain: true,
    name: "Main agent",
    task: null,
  },
  event: {
    id: "sample-event",
    name: "Sample CTF",
    platform: "ctfd",
    promptHint: "",
  },
  challenge: {
    id: "sample-challenge",
    name: "Encrypted Notes",
    description: "Recover the flag from the provided application.",
    category: "web",
    points: 300,
    attachments: [
      { name: "challenge.zip", path: "challenge.zip", size: 12_345 },
    ],
    attachmentPaths: ["challenge.zip"],
  },
  model: {
    provider: "Sample Provider",
    name: "Sample Model",
    id: "sample-model",
  },
  run: {
    id: "sample-run",
    environment: "container",
    isContainer: true,
    workspace: "/workspace",
    targetSupported: true,
    platformIntegrated: true,
    containerImage: "aegisx/solve:latest",
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 256,
  },
  capabilities: {
    canFinish: true,
    canSpawn: true,
    canSubmitFlag: true,
    canManageTarget: true,
  },
}

function render(template: string, context: PromptTemplateContext) {
  return handlebars
    .compile(template, { noEscape: true, strict: true })(context, {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    })
    .trim()
}

/** Render an arbitrary template body with the shared configured handlebars
 * instance (noEscape, strict, `join` helper). Used by the prompt_templates
 * store so all rendering goes through one handlebars configuration. The
 * context is loosely typed — orchestration PromptContext is a superset of the
 * legacy {@link PromptTemplateContext} shape (challenge optional, capabilities
 * optional), and the built-in templates only reference fields that the caller
 * has populated. */
export function renderTemplateBody(template: string, context: unknown): string {
  return render(template, context as PromptTemplateContext)
}

const HIGHLIGHT_START = "\uE000"
const HIGHLIGHT_END = "\uE001"

function markPreviewValues(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number") {
    return `${HIGHLIGHT_START}${value}${HIGHLIGHT_END}`
  }
  if (Array.isArray(value)) return value.map(markPreviewValues)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, markPreviewValues(item)])
    )
  }
  return value
}

function previewSegments(value: string): PromptPreviewSegment[] {
  const segments: PromptPreviewSegment[] = []
  let offset = 0
  while (offset < value.length) {
    const start = value.indexOf(HIGHLIGHT_START, offset)
    if (start === -1) {
      segments.push({
        id: segments.length,
        text: value.slice(offset),
        highlighted: false,
      })
      break
    }
    if (start > offset) {
      segments.push({
        id: segments.length,
        text: value.slice(offset, start),
        highlighted: false,
      })
    }
    const end = value.indexOf(HIGHLIGHT_END, start + 1)
    if (end === -1) {
      segments.push({
        id: segments.length,
        text: value.slice(start + 1),
        highlighted: true,
      })
      break
    }
    segments.push({
      id: segments.length,
      text: value.slice(start + 1, end),
      highlighted: true,
    })
    offset = end + 1
  }
  return segments
    .flatMap((segment) => {
      if (segment.highlighted) return [segment]
      return segment.text
        .split(/(\b(?:true|false)\b)/)
        .filter(Boolean)
        .map((text) => ({
          ...segment,
          text,
          highlighted: text === "true" || text === "false",
        }))
    })
    .map((segment, id) => ({ ...segment, id }))
}

/** Variables available to the orchestrator system-prompt template. The
 * orchestrator has no challenge/run/agent context — only the owning event and
 * the user's natural-language instruction. */
export const ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES = [
  "event.id",
  "event.name",
  "instruction",
] as const

export type OrchestratorPromptContext = {
  event: { id: string; name: string }
  instruction: string
}

export const sampleOrchestratorPromptContext: OrchestratorPromptContext = {
  event: { id: "sample-event", name: "Sample CTF" },
  instruction: "Hit crypto first; leave pwn for last.",
}

export function renderSystemPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return render(template, context)
}

function renderOrchestratorSystemPrompt(
  template: string,
  context: OrchestratorPromptContext
) {
  return handlebars
    .compile(template, { noEscape: true, strict: true })(context, {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    })
    .trim()
}

function renderInitialPrompt(template: string, context: PromptTemplateContext) {
  return render(template, context)
}

export function previewSystemPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return previewSegments(
    renderSystemPrompt(
      template,
      markPreviewValues(context) as PromptTemplateContext
    )
  )
}

export function previewOrchestratorSystemPrompt(
  template: string,
  context: OrchestratorPromptContext
) {
  return previewSegments(
    renderOrchestratorSystemPrompt(
      template,
      markPreviewValues(context) as OrchestratorPromptContext
    )
  )
}

export function previewInitialPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return previewSegments(
    renderInitialPrompt(
      template,
      markPreviewValues(context) as PromptTemplateContext
    )
  )
}
