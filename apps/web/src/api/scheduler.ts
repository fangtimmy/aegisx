import { apiRequest } from "./client"
import type { QueueItem, SchedulerInfo } from "./types"

export function getScheduler(eventId: string) {
  return apiRequest<SchedulerInfo>(`/events/${eventId}/scheduler`)
}

export function listQueue(eventId: string) {
  return apiRequest<{ items: QueueItem[] }>(`/events/${eventId}/queue`)
}
