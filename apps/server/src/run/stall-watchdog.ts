import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import { agents, runs } from "../db/schema"
import { orchKey, type ChannelService } from "./channels"

/** agent 停滞判定：turn settle 后超过该时长仍 idle/failed → urgent orch
 * 消息（§五）。 */
export const AGENT_STALL_MS = 2 * 60_000

/** 时间格式化（watchdog 行与 SDK `fmt_ms` 共用格式约定）：
 *  3500 → "4s"；210000 → "3m30s"；-45000 → "-45s(超时)"。 */
export function fmtMs(ms: number): string {
  if (ms < 0) return `-${fmtMs(-ms)}(超时)`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem === 0 ? `${h}h` : `${h}h${rem}m`
  }
  return s === 0 ? `${m}m` : `${m}m${s}s`
}

export type StallWatchdogDeps = {
  db: Database
  channels: ChannelService
  /** W3: the event's scheduler is paused → stall checks do not arm (same
   * arm condition as the digest-era watchdog). */
  isSchedulerPaused(eventId: string): boolean
  /** Test seam: stall threshold. */
  stallMs?: number
}

export type StallWatchdog = ReturnType<typeof createStallWatchdog>

/**
 * 停滞 watchdog（docs/im-simplify-v18.md §五）：agent turn settle 后 arm
 * 2min 计时器，到点现查该 run 仍有 idle/failed agent → post 一条 urgent
 * 消息到 orch:<eventId>（调度者不在线时只存储，下次启动 catch-up——不再
 * 依赖任何 live 实例）。每个 idle 周期只触发一次（再次 settle 重新 arm）。
 */
export function createStallWatchdog(deps: StallWatchdogDeps) {
  const { db, channels } = deps
  const stallMs = deps.stallMs ?? AGENT_STALL_MS
  const timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dueAt: number }
  >()

  /** agent turn settled (idle/failed): arm the run's stall check. The fire
   * time re-checks the DB, so a mid-timer resume/finish is judged from
   * current state (race-safe). Challenge-scope only; paused events skip. */
  function noteAgentIdle(runId: string): void {
    const row = db
      .select({
        scopeType: runs.scopeType,
        eventId: runs.eventId,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()
    if (!row || row.scopeType !== "challenge") return
    if (deps.isSchedulerPaused(row.eventId)) return
    clearStallTimer(runId)
    const dueAt = Date.now() + stallMs
    const timer = setTimeout(() => {
      timers.delete(runId)
      checkStall(runId)
    }, stallMs)
    timers.set(runId, { timer, dueAt })
  }

  function clearStallTimer(runId: string): void {
    const entry = timers.get(runId)
    if (entry) {
      clearTimeout(entry.timer)
      timers.delete(runId)
    }
  }

  /** Timer fired: re-check the run — an idle/failed agent still idle ≥
   * stallMs posts the urgent orch message; otherwise silent. A finishing or
   * closed run never fires a false alarm. */
  function checkStall(runId: string): void {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!row || row.status === "closed" || row.finishing) return
    if (deps.isSchedulerPaused(row.eventId)) return
    const nowMs = Date.now()
    const stalled = db
      .select()
      .from(agents)
      .where(
        and(eq(agents.runId, runId), inArray(agents.status, ["idle", "failed"]))
      )
      .all()
      .filter((agent) => nowMs - Date.parse(agent.updatedAt) >= stallMs)
    if (!stalled.length) return
    const detail = stalled
      .map(
        (agent) =>
          `${agent.name ?? agent.slot} 已闲置 ${fmtMs(nowMs - Date.parse(agent.updatedAt))}`
      )
      .join("、")
    channels.post({
      channelKey: orchKey(row.eventId),
      author: { type: "system" },
      body: `停滞：run-${runId.slice(0, 8)} — ${detail}`,
      meta: { runId, noticeType: "emergency" },
      urgent: true,
    })
  }

  /** Clear every timer (service close). Messages already posted persist. */
  function close(): void {
    for (const { timer } of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return { noteAgentIdle, close }
}
