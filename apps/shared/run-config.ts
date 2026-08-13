import type { ThinkingLevel } from "./thinking"

/** v3 is container-only; every run is a Docker container running pi. */
export type EnvironmentConfig = {
  type: "container"
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
}

export type ModelConfig = {
  provider: string
  providerLabel?: string
  modelId: string
  modelLabel?: string
  baseUrl?: string
  costKnown?: boolean
  thinkingLevel: ThinkingLevel
}

export type PromptAttachment = {
  name: string
  path: string
  size: number
}

/**
 * Prompt template context (handlebars). v4 renders these host-side and feeds
 * them to the pi SDK via a custom ResourceLoader (no APPEND_SYSTEM.md in the
 * container). The main agent can spawn children; capabilities reflect the
 * native tools registered for the run.
 */
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
    /** v3 is container-only — every run runs in a Docker container. */
    environment: "container"
    isContainer: true
    workspace: string
    targetSupported: boolean
    platformIntegrated: boolean
    containerImage: string
    cpus: number
    memoryMb: number
    pidsLimit: number
  }
  capabilities: {
    canFinish: boolean
    canSpawn: boolean
    canSubmitFlag: boolean
    canManageTarget: boolean
  }
}

export type FrozenPromptConfig = {
  mainSystemPromptTemplate: string
  childSystemPromptTemplate: string
  initialPromptTemplate: string
  context?: PromptTemplateContext
}
