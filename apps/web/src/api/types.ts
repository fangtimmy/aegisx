export type {
  AgentInspector,
  AgentPublic,
  AgentRuntimeSnapshot,
  AgentStatus,
  AgentSummary,
  AgentToolStats,
  Attachment,
  Challenge,
  ChallengeInput,
  ChallengeSyncResult,
  ConversationMessage,
  EventInput,
  EventPlatform,
  EventStats,
  EventSummary,
  ModelMetadata,
  PiModelProfile,
  PlatformType,
  ProviderConnection,
  ProviderModel,
  ProviderType,
  PublicAgentMessage,
  PublicAssistantMessage,
  PublicToolResultMessage,
  PublicUserMessage,
  RemoteChallengeSummary,
  RemoteEvent,
  RunFile,
  RunFileEntry,
  RunPublic,
  RunStatus,
  RunStreamEvent,
  SettingsPublic,
  TargetState,
  ThinkingLevel,
  UsageSummary,
} from "../../../shared"

export { isPublicAgentMessage } from "../../../shared"

import type {
  AgentSummary,
  ConversationMessage,
  RunPublic,
  UsageSummary,
} from "../../../shared"

export type RunDetail = {
  run: RunPublic
  agents: AgentSummary[]
  messages: ConversationMessage[]
  stats: UsageSummary
  cursor: number
}

export type AgentConversation = {
  runId: string
  agentId: string
  messages: ConversationMessage[]
  cursor: number
}
