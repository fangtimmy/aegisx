import type {
  AgentStatus,
  EnvironmentConfig,
  FrozenPromptConfig,
  Message,
  ModelConfig,
  RunStatus,
} from "../../../shared"

export type AgentOutcome = {
  status: "success" | "error" | "aborted"
  summary: string | null
  error: string | null
}

export type AgentRecord = {
  id: string
  runId: string
  parentAgentId: string | null
  name: string
  task: string | null
  status: AgentStatus
  summary: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
}

export type RunAggregate = {
  id: string
  challengeId: string
  status: RunStatus
  mainAgentId: string
  modelJson: string
  envJson: string
  promptJson: string
  workspacePath: string | null
  pendingFinishSummary: string | null
  error: string | null
  summary: string | null
  flag: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  agents: AgentRecord[]
}

export type DispatchKind = "bootstrap" | "user" | "resume" | "notice"

export type Effect =
  | { t: "abort_all"; exceptAgentId?: string }
  | { t: "release_all" }
  | { t: "release_agent"; agentId: string }
  | { t: "attach"; agentId: string }
  | {
      t: "dispatch"
      agentId: string
      kind: DispatchKind
      text: string
      messageId: string
      clientMessageId?: string
      handoff?: {
        agentId: string
        agentName: string
        status: string
      }
    }
  | { t: "insert_message"; message: Message }

export type Cmd =
  | {
      t: "create"
      runId: string
      mainAgentId: string
      challengeId: string
      model: ModelConfig
      env: EnvironmentConfig
      prompt: FrozenPromptConfig
      workspacePath: string
      bootstrapText: string
      bootstrapMessageId: string
      now: string
    }
  | {
      t: "user_message"
      text: string
      messageId: string
      clientMessageId?: string
      now: string
    }
  | { t: "pause"; now: string }
  | {
      t: "resume"
      text: string
      messageId: string
      clientMessageId?: string
      now: string
    }
  | { t: "stop"; now: string }
  | { t: "request_finish"; summary: string }
  | { t: "main_settled"; outcome: AgentOutcome; now: string }
  | {
      t: "child_settled"
      agentId: string
      outcome: AgentOutcome
      noticeMessageId: string
      now: string
    }
  | {
      t: "spawn"
      agentId: string
      parentId: string
      name: string
      task: string
      taskMessageId: string
      now: string
    }
  | { t: "container_failed"; error: string; now: string }
  | { t: "recover_on_boot"; now: string }

export type ReduceErrorCode =
  | "not_found"
  | "invalid_state"
  | "capacity"
  | "message_id_conflict"

export type ReduceOk = {
  ok: true
  state: RunAggregate
  effects: Effect[]
}

export type ReduceErr = {
  ok: false
  code: ReduceErrorCode
  message: string
}

export type ReduceResult = ReduceOk | ReduceErr

export function mainAgent(state: RunAggregate): AgentRecord | undefined {
  return state.agents.find((agent) => agent.id === state.mainAgentId)
}

export function agentById(
  state: RunAggregate,
  agentId: string
): AgentRecord | undefined {
  return state.agents.find((agent) => agent.id === agentId)
}

export function isMain(agent: AgentRecord): boolean {
  return agent.parentAgentId === null
}
