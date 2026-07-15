export type RemoteChallenge = {
  id: string
  name: string
  description: string
  category?: string
  points?: number
}

export type RemoteAttachment = {
  filename: string
  body: ReadableStream<Uint8Array>
}

export type TargetInfo = { host: string; expiresAt?: string }
export type FlagResult = { accepted: boolean; message?: string }

export interface CtfPlatformAdapter {
  listChallenges(): Promise<RemoteChallenge[]>
  getChallenge(remoteId: string): Promise<RemoteChallenge>
  downloadAttachments(remoteId: string): Promise<RemoteAttachment[]>
  startTarget(remoteId: string): Promise<TargetInfo>
  stopTarget(remoteId: string): Promise<void>
  submitFlag(remoteId: string, flag: string): Promise<FlagResult>
}
