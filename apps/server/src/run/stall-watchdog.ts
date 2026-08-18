import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { agents } from "../db/schema"
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
  /** W3: the event's scheduler is paused → stall checks do not arm. */
  isSchedulerPaused(eventId: string): boolean
  /** Test seam: stall threshold. */
  stallMs?: number
}

export type StallWatchdog = ReturnType<typeof createStallWatchdog>

/**
 * 停滞 watchdog（per-agent，docs/model-v19-challenge-centric.md §四）：agent
 * turn settle 后 arm 2min 计时器，到点现查该 agent 仍 idle/failed → post
 * 一条 urgent 消息到 orch:<eventId>（调度者不在线时只存储，下次启动
 * catch-up）。每个 idle 周期只触发一次（再次 settle 重新 arm）。
 */
export function createStallWatchdog(deps: StallWatchdogDeps) {
  const { db, channels } = deps
  const stallMs = deps.stallMs ?? AGENT_STALL_MS
  const timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dueAt: number }
  >()

  /** Agent turn settled (idle/failed): arm the agent's stall check. The
   * fire time re-checks the DB, so a mid-timer resume/finish is judged from
   * current state (race-safe). Solver agents only; paused events skip. */
  function noteAgentIdle(agentId: string): void {
    const row = db
      .select({
        role: agents.role,
        eventId: agents.eventId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()
    if (!row || row.role !== "solver") return
    if (deps.isSchedulerPaused(row.eventId)) return
    clearStallTimer(agentId)
    const dueAt = Date.now() + stallMs
    const timer = setTimeout(() => {
      timers.delete(agentId)
      checkStall(agentId)
    }, stallMs)
    timers.set(agentId, { timer, dueAt })
  }

  function clearStallTimer(agentId: string): void {
    const entry = timers.get(agentId)
    if (entry) {
      clearTimeout(entry.timer)
      timers.delete(agentId)
    }
  }

  /** Timer fired: re-check the agent — an idle/failed agent still idle ≥
   * stallMs posts the urgent orch message; otherwise silent. A terminal
   * agent never fires a false alarm. */
  function checkStall(agentId: string): void {
    const row = db.select().from(agents).where(eq(agents.id, agentId)).get()
    if (!row || row.role !== "solver") return
    if (row.status !== "idle" && row.status !== "failed") {
      return
    }
    if (deps.isSchedulerPaused(row.eventId)) return
    const nowMs = Date.now()
    if (nowMs - Date.parse(row.updatedAt) < stallMs) return
    channels.post({
      channelKey: orchKey(row.eventId),
      author: { type: "system" },
      body: `停滞：agent-${agentId.slice(0, 8)} 已闲置 ${fmtMs(nowMs - Date.parse(row.updatedAt))}`,
      meta: { agentId, noticeType: "emergency" },
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
