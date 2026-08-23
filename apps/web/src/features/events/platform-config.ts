import type { QueryClient } from "@tanstack/react-query"

import { keys, type PlatformType } from "@/api"

export const PLATFORM_TYPES = [
  "ctfd",
  "ret2shell",
  "a1ctf",
  "tsecbench",
  "dasctf",
] as const satisfies readonly PlatformType[]

export const platformLabels: Record<PlatformType, string> = {
  ctfd: "CTFd",
  ret2shell: "ret2shell",
  a1ctf: "A1CTF",
  tsecbench: "TSecBench",
  dasctf: "DASCTF",
}

export const credentialLabels: Record<PlatformType, string> = {
  ctfd: "访问令牌",
  ret2shell: "Bearer token",
  a1ctf: "a1token cookie",
  tsecbench: "BENCHMARK_TOKEN",
  dasctf: "X-Agent-AccessKey",
}

export const credentialPrefixes: Partial<Record<PlatformType, string>> = {
  ret2shell: "Bearer",
  a1ctf: "a1token=",
}

/** Pre-filled platform URL when the user has not typed one yet. */
export const defaultBaseUrls: Partial<Record<PlatformType, string>> = {
  ret2shell: "https://ctf.xidian.edu.cn",
  a1ctf: "https://a1natas.com",
  tsecbench: "https://tsecbench.zc.tencent.com",
  dasctf: "https://pro.dasctf.com",
}

/** Platforms without a real event list: the server binds a fixed synthetic
 * remoteEventId instead of one discovered via /platform/events/discover. */
export const fixedRemoteEventIds: Partial<Record<PlatformType, string>> = {
  ctfd: "site",
  tsecbench: "task",
  dasctf: "match",
}

export async function refreshEvent(queryClient: QueryClient, eventId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    queryClient.invalidateQueries({ queryKey: keys.events.all }),
    queryClient.invalidateQueries({ queryKey: keys.agents.fleet(eventId) }),
  ])
}
