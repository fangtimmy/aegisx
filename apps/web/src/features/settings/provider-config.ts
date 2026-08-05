import type { ProviderType } from "@/api"

export const providerTypeLabels: Record<ProviderType, string> = {
  "openai-compatible": "OpenAI 兼容",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
}

export const providerTypeDefaults: Record<ProviderType, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
}

export const providerTypes = Object.keys(providerTypeLabels) as ProviderType[]

export type ProviderInput = {
  label: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  enabled: boolean
}
