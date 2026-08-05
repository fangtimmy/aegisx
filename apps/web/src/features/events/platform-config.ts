import type { QueryClient } from "@tanstack/react-query"
import { keys, type PlatformType } from "@/api"

export const platformLabels: Record<PlatformType, string> = {
  ctfd: "CTFd",
  ret2shell: "ret2shell",
  a1ctf: "A1CTF",
}

export const credentialLabels: Record<PlatformType, string> = {
  ctfd: "访问令牌",
  ret2shell: "Bearer token",
  a1ctf: "a1token cookie",
}

export const credentialPrefixes: Partial<Record<PlatformType, string>> = {
  ret2shell: "Bearer",
  a1ctf: "a1token=",
}

export async function refreshEvent(queryClient: QueryClient, eventId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.all }),
    queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) }),
  ])
}
