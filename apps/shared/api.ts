export type EventSummary = {
  id: string
  name: string
  platform: EventPlatform | null
  createdAt: string
  updatedAt: string
  challengeCount: number
  solvedCount: number
  activeRunCount: number
  lastActivityAt: string
}

export type EventInput = {
  name: string
}

export type Attachment = {
  id: string
  challengeId: string
  originalName: string
  size: number
  sha256: string
  createdAt: string
  downloadUrl: string
}

export type Challenge = {
  id: string
  eventId: string
  name: string
  description: string
  category: string | null
  points: number | null
  createdAt: string
  updatedAt: string
  attachments: Attachment[]
  runCount: number
  remoteId: string | null
  remoteAvailable: boolean
  remoteSolved: boolean
  remoteTarget: boolean
  remoteTargetIgnored: boolean
  remoteTargetCount: number
  targets: Array<{ name: string; services: string[] }>
  remoteUpdatedAt: string | null
  status: "not_started" | "in_progress" | "solved"
}

export type ChallengeInput = {
  name: string
  description: string
  category: string | null
  points: number | null
}

export type PlatformType = "ctfd" | "ret2shell" | "a1ctf"
export type RemoteEvent = { id: string; name: string }

export type EventPlatform = {
  eventId: string
  type: PlatformType
  baseUrl: string
  credential: string
  remoteEventId: string
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
  credentialConfigured: boolean
}

export type RemoteChallengeSummary = {
  id: string
  name: string
  category: string | null
  points: number | null
  solved: boolean
  imported: boolean
  localChallengeId: string | null
}

export type ChallengeSyncResult = {
  syncedAt: string
  results: Array<{
    remoteId: string
    status: "created" | "updated" | "failed"
    challengeId?: string
    error?: string
  }>
}

export type TargetState = {
  status: "absent" | "starting" | "running" | "stopping" | "failed"
  endpoints: Array<{
    name: string
    address: string
    protocol: "http" | "https" | "ws" | "wss" | "tcp" | "udp"
    guidance?: string[]
  }>
  expiresAt: string | null
  message?: string
}

export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"

export type AgentStatus = RunStatus | "idle"

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type RunPublic = {
  id: string
  challengeId: string
  challengeName: string
  eventId: string
  status: RunStatus
  provider: string
  modelId: string
  modelName: string
  thinkingLevel: ThinkingLevel
  environment: "local" | "container"
  targetSupported: boolean
  image?: string | null
  cpus?: number
  memoryMb?: number
  pidsLimit?: number
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  error: string | null
  summary: string | null
  hasFlag: boolean
  flag?: string | null
}

export type RunStreamEvent =
  | {
      type: "ready"
      runId: string
      cursor: number
    }
  | {
      type: "run.updated"
      run: RunPublic
      cursor?: number
    }
  | {
      type: "agent.updated"
      agent: AgentSummary
      cursor?: number
    }
  | {
      type: "message.progress"
      agentId: string
      messageId: string
      revision: number
      message: Record<string, unknown>
    }
  | {
      type: "tool.progress"
      agentId: string
      toolCallId: string
      revision: number
      toolName: string
      args: unknown
      result?: unknown
      status: "running" | "done" | "error"
      isError?: boolean
    }
  | {
      type: "message.committed"
      agentId: string
      cursor: number
      message: ConversationMessage
    }

export type AgentPublic = {
  id: string
  runId: string
  parentAgentId: string | null
  name: string
  status: AgentStatus
  summary: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
}

export type UsageSummary = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number | null
}

export type AgentSummary = AgentPublic & { usage: UsageSummary }

export type ConversationMessage = {
  id: string
  agentId: string
  sequence: number
  message: Record<string, unknown>
  createdAt: string
}

export type AgentRuntimeSnapshot = {
  capturedAt: string
  systemPrompt: string
  cwd: string
  model: { provider: string; modelId: string; thinkingLevel: ThinkingLevel }
  tools: Array<{
    name: string
    description: string
    parameters: unknown
    promptGuidelines?: string[]
  }>
}

export type AgentToolStats = {
  toolName: string
  callCount: number
  failedCount: number
  durationMs: number
  outputBytes: number
  truncatedCount: number
}

export type AgentInspector = {
  agent: AgentPublic
  task: string | null
  runtime: AgentRuntimeSnapshot | null
  usage: UsageSummary
  toolStats: AgentToolStats[]
}

export type SettingsPublic = {
  defaultModelId: string | null
  environment: "local" | "container"
  containerImage: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  maxConcurrency: number
  maxAttachmentMb: number
  mainSystemPromptTemplate: string
  childSystemPromptTemplate: string
  initialPromptTemplate: string
  defaultMainSystemPromptTemplate: string
  defaultChildSystemPromptTemplate: string
  defaultInitialPromptTemplate: string
  promptTemplateVariables: string[]
  updatedAt: string
}

export type ProviderType =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-messages"

export type ModelMetadata = {
  reasoning: boolean
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>
  input: Array<"text" | "image">
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    tiers?: Array<{
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      inputTokensAbove: number
    }>
  }
  costKnown: boolean
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}

export type PiModelProfile = {
  providerId: string
  modelId: string
  name: string
}

export type ProviderModel = {
  id: string
  providerId: string
  modelId: string
  label: string
  enabled: boolean
  metadata: ModelMetadata
  piBinding: { providerId: string; modelId: string } | null
  thinkingLevels: ThinkingLevel[]
  createdAt: string
  updatedAt: string
}

export type ProviderConnection = {
  id: string
  label: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  models: ProviderModel[]
}

export type EventStats = {
  eventId: string
  runCount: number
  usage: UsageSummary
  challenges: Array<{
    challengeId: string
    challengeName: string
    runCount: number
    usage: UsageSummary
  }>
  runs: Array<{ run: RunPublic; usage: UsageSummary }>
}

export type RunFileEntry = {
  name: string
  path: string
  type: "file" | "directory"
  size: number
  modifiedAt: string
}

export type RunFile =
  | {
      path: string
      type: "directory"
      entries: RunFileEntry[]
    }
  | {
      path: string
      type: "text"
      size: number
      modifiedAt: string
      content: string
      truncated: boolean
    }
  | {
      path: string
      type: "binary"
      size: number
      modifiedAt: string
    }
