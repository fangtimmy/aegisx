import Handlebars from "handlebars"
import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
} from "../../../shared/prompt-defaults"

export {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
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
  "capabilities.canFinishRun",
  "capabilities.canSpawnAgent",
  "capabilities.canSubmitFlag",
  "capabilities.canManageTarget",
] as const

export type PromptTemplates = {
  mainSystemPromptTemplate: string
  childSystemPromptTemplate: string
  initialPromptTemplate: string
}

export type PromptPreviewSegment = {
  id: number
  text: string
  highlighted: boolean
}

export type PromptAttachment = {
  name: string
  path: string
  size: number
}

export type PromptTemplateContext = {
  agent: {
    role: "main" | "child"
    isMain: boolean
    name: string
    task: string | null
  }
  event: {
    id: string
    name: string
    platform: string | null
    promptHint: string
  }
  challenge: {
    id: string
    name: string
    description: string
    category: string | null
    points: number | null
    attachments: PromptAttachment[]
    attachmentPaths: string[]
  }
  model: {
    provider: string
    name: string
    id: string
  }
  run: {
    id: string
    environment: "local" | "container"
    isContainer: boolean
    workspace: string
    targetSupported: boolean
    platformIntegrated: boolean
    containerImage: string | null
    cpus: number | null
    memoryMb: number | null
    pidsLimit: number | null
  }
  capabilities: {
    canFinishRun: boolean
    canSpawnAgent: boolean
    canSubmitFlag: boolean
    canManageTarget: boolean
  }
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
    canFinishRun: true,
    canSpawnAgent: true,
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

export function renderSystemPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return render(template, context)
}

export function renderInitialPrompt(
  template: string,
  context: PromptTemplateContext
) {
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

export function resolvePromptTemplates(settings: {
  "prompts.mainSystem"?: string
  "prompts.childSystem"?: string
  "prompts.initial"?: string
  mainSystemPromptTemplate?: string
  childSystemPromptTemplate?: string
  initialPromptTemplate?: string
}): PromptTemplates {
  return {
    mainSystemPromptTemplate:
      settings["prompts.mainSystem"] ??
      settings.mainSystemPromptTemplate ??
      DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
    childSystemPromptTemplate:
      settings["prompts.childSystem"] ??
      settings.childSystemPromptTemplate ??
      DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
    initialPromptTemplate:
      settings["prompts.initial"] ??
      settings.initialPromptTemplate ??
      DEFAULT_INITIAL_PROMPT_TEMPLATE,
  }
}
