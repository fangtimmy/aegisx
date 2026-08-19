import type { ActivitySnapshot } from "@aegisx/shared"

import { apiRequest } from "./client"

export function getActivity(limit = 100) {
  return apiRequest<ActivitySnapshot>(`/activity?limit=${limit}`)
}
