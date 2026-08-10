import { apiRequest, jsonRequest } from "./client"
import type {
  Attachment,
  Challenge,
  ChallengeFlag,
  ChallengeInput,
  SolveState,
  TargetState,
} from "./types"

export function updateChallenge(challengeId: string, input: ChallengeInput) {
  return apiRequest<Challenge>(
    `/challenges/${challengeId}`,
    jsonRequest("PATCH", input)
  )
}

export function deleteChallenge(challengeId: string) {
  return apiRequest<void>(`/challenges/${challengeId}`, { method: "DELETE" })
}

export function uploadAttachment(challengeId: string, file: File) {
  return apiRequest<Attachment>(
    `/challenges/${challengeId}/attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }
  )
}

export function deleteAttachment(attachmentId: string) {
  return apiRequest<void>(`/attachments/${attachmentId}`, { method: "DELETE" })
}

export function getTarget(challengeId: string) {
  return apiRequest<TargetState>(`/challenges/${challengeId}/target`)
}

export function targetAction(
  challengeId: string,
  action: "start" | "extend" | "stop"
) {
  return apiRequest<TargetState>(
    `/challenges/${challengeId}/target/${action}`,
    jsonRequest("POST", {})
  )
}

export function ignoreTarget(challengeId: string) {
  return apiRequest<void>(`/challenges/${challengeId}/target`, {
    method: "DELETE",
  })
}

export function setChallengeSolved(challengeId: string, state: SolveState) {
  return apiRequest<Challenge>(
    `/challenges/${challengeId}/solved`,
    jsonRequest("PATCH", { state })
  )
}

export function addManualFlag(challengeId: string, flag: string) {
  return apiRequest<{ flag: ChallengeFlag }>(
    `/challenges/${challengeId}/flags`,
    jsonRequest("POST", { flag })
  )
}

export function deleteManualFlag(challengeId: string, flagId: string) {
  return apiRequest<void>(`/challenges/${challengeId}/flags/${flagId}`, {
    method: "DELETE",
  })
}

export function refreshChallengeRemote(challengeId: string) {
  return apiRequest<Challenge>(
    `/challenges/${challengeId}/remote/refresh`,
    jsonRequest("POST", {})
  )
}
