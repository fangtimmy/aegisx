import type { EnvironmentConfig, ModelConfig, RunPublic } from "../../../shared"
import type { RunAggregate } from "./types"

export type ChallengeMeta = {
  name: string
  eventId: string
  targetSupported: boolean
}

export function toRunPublic(
  state: RunAggregate,
  challenge?: ChallengeMeta
): RunPublic {
  let model: ModelConfig
  let env: EnvironmentConfig
  try {
    model = JSON.parse(state.modelJson) as ModelConfig
    env = JSON.parse(state.envJson) as EnvironmentConfig
  } catch {
    model = {
      provider: "unknown",
      modelId: "unknown",
      thinkingLevel: "off",
    }
    env = { type: "local" }
  }
  return {
    id: state.id,
    mainAgentId: state.mainAgentId,
    challengeId: state.challengeId,
    challengeName: challenge?.name ?? "",
    eventId: challenge?.eventId ?? "",
    status: state.status,
    provider: model.providerLabel ?? model.provider,
    modelId: model.modelId,
    modelName: model.modelLabel ?? model.modelId,
    thinkingLevel: model.thinkingLevel,
    environment: env.type,
    targetSupported: challenge?.targetSupported ?? false,
    image: env.type === "container" ? env.image : null,
    cpus: env.type === "container" ? env.cpus : undefined,
    memoryMb: env.type === "container" ? env.memoryMb : undefined,
    pidsLimit: env.type === "container" ? env.pidsLimit : undefined,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    error: state.error,
    summary: state.summary,
    hasFlag: Boolean(state.flag),
    flag: state.flag,
  }
}
