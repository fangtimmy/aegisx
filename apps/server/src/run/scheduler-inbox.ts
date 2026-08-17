import { get, type FlatSettings } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Database } from "../db"
import {
  agents,
  challenges,
  runs,
  runQueue,
  schedulerInboxDigests,
} from "../db/schema"
import type { EventScopePayload } from "../orchestration/types"

/** 时间格式化（digest 与 SDK `fmt_ms` 共用格式约定）：
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

/** 静默 flush 间隔：距最后一条入队消息无新消息多久后结算一轮。 */
const SILENCE_MS = 5 * 60_000
/** digest 行上限（超出折叠为「…另有 N 个 run 事件」）。 */
const MAX_RUN_LINES = 20
/** active run 停滞判定（最近活动超过该值标 ⚠）。 */
const STALL_MS = 25 * 60_000
/** deadline 临近判定（剩余少于该值标 ⚠）。 */
const DEADLINE_NEAR_MS = 10 * 60_000
/** agent 停滞判定：turn settle 后超过该时长仍 idle/failed → 紧急 flush。 */
const AGENT_STALL_MS = 2 * 60_000

export type SchedulerInboxDeps = {
  eventId: string
  /** flush 时 digest 的投递目标（事件作用域的 orchestrator agent）。 */
  orchestratorAgentId: string
  db: Database
  getSettings(): FlatSettings
  /** 投递 digest（steer；fire-and-forget，错误吞掉）。 */
  send(text: string): void
  now(): string
  /** 调度器暂停时收件箱整体静默（队列紧急事件也 gate；run 事件已在
   * emitRunEvent 丢弃，继承其静默语义）。 */
  isPaused(): boolean
  /** 测试 seam：静默 flush 间隔。 */
  silenceMs?: number
  /** 测试 seam：agent 停滞判定间隔。 */
  stallMs?: number
}

export type SchedulerInbox = ReturnType<typeof createSchedulerInbox>

/**
 * 调度者消极收件箱（docs/scheduler-inbox.md）：事件只入队、静默等待，
 * 直到真正需要调度者行动时一次性结算（digest），替代逐事件直接唤醒。
 *
 * - 普通事件（started / idle / finished / resumed / flagAccepted）只入队并
 *   重置静默计时器；`timedOut` 与队列紧急事件（不足 / 启动失败）立即 flush，
 *   捎带已积攒的普通行。
 * - flush 时服务端现查状态（run 行 / challenge 名 / active+pending 计数）
 *   组装静态快照 digest，以 steer 投递；随后清空队列与计时器。
 * - 生命周期与 EventScopeEmitter 同步：scheduler run teardown / service
 *   close 时 `close()` 清空；恢复后调度者靠 snapshot re-sync（既有先例）。
 */
export function createSchedulerInbox(deps: SchedulerInboxDeps) {
  const { db, getSettings } = deps
  const silenceMs = deps.silenceMs ?? SILENCE_MS
  const stallMs = deps.stallMs ?? AGENT_STALL_MS
  /** runId → 已入队事件序列（同 run 多事件合并为一行）。 */
  const lines = new Map<string, string[]>()
  /** 紧急行（队列不足 / 启动失败 / agent 停滞），随下一次 flush 一并投递。 */
  const emergency: string[] = []
  /** 普通通知行（队列 pause/resume 等非 run 事件）：只入队，随下一次
   * flush（静默或紧急）投递，不单独触发。 */
  const notices: string[] = []
  /** runId → 停滞检查计时器：agent settle 后 arm，到点现查该 run 是否
   * 仍有 idle/failed agent（距今 ≥ stallMs）→ 紧急 flush。每个 idle 周期
   * 只触发一次（再次 settle 重新 arm）。 */
  const stallTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dueAt: number }
  >()
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 静默计时器预定 flush 时刻（epoch ms；null = 未 arm）。 */
  let timerDueAt: number | null = null

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 静默计时器：从最后一条入队消息起算，新消息刷新。 */
  function armTimer(): void {
    clearTimer()
    timerDueAt = Date.now() + silenceMs
    timer = setTimeout(() => {
      timer = null
      timerDueAt = null
      flush()
    }, silenceMs)
  }

  /** 事件显示名（digest 行的事件序列元素）。 */
  function eventName(p: EventScopePayload): string {
    switch (p.type) {
      case "run.started":
        return p.source === "manual" ? "started(手动)" : "started"
      case "run.idle":
        return p.failed ? "idle(failed)" : "idle"
      case "run.flagAccepted":
        return "flagAccepted"
      case "run.finished":
        return "finished"
      case "run.timedOut":
        return `timedOut(${p.outcome})`
      case "run.resumed":
        return "resumed"
    }
  }

  /** 普通事件只入队；紧急事件（timedOut）立即 flush（捎带已积攒行）。 */
  function push(payload: EventScopePayload): void {
    const list = lines.get(payload.runId) ?? []
    list.push(eventName(payload))
    lines.set(payload.runId, list)
    if (payload.type === "run.timedOut") flush()
    else armTimer()
  }

  /** 队列紧急事件（不足 / 启动失败）：入队紧急行并立即 flush。paused 时静默。 */
  function pushEmergency(line: string): void {
    if (deps.isPaused()) return
    emergency.push(line)
    flush()
  }

  /** 普通通知行（队列 pause/resume 等）：只入队并重置静默计时器，随下一
   * 次 flush 投递——不紧急，不打断。paused 时静默。 */
  function pushNotice(line: string): void {
    if (deps.isPaused()) return
    notices.push(line)
    armTimer()
  }

  /** agent turn settle：arm 该 run 的停滞检查计时器（fire 时现查，竞态
   * 安全——中途 resumed/finished 由 DB 现状裁决）。paused 时静默。 */
  function noteAgentIdle(runId: string): void {
    if (deps.isPaused()) return
    clearStallTimer(runId)
    const dueAt = Date.now() + stallMs
    const timer = setTimeout(() => {
      stallTimers.delete(runId)
      checkStall(runId)
    }, stallMs)
    stallTimers.set(runId, { timer, dueAt })
  }

  function clearStallTimer(runId: string): void {
    const entry = stallTimers.get(runId)
    if (entry) {
      clearTimeout(entry.timer)
      stallTimers.delete(runId)
    }
  }

  /** 停滞计时器到点：现查该 run，仍有 idle/failed agent 且距今 ≥
   * stallMs → 紧急行 + flush；否则静默（下次 settle 重新 arm）。 */
  function checkStall(runId: string): void {
    if (deps.isPaused()) return
    const row = db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!row || row.status === "closed") return
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
          `${agent.name ?? agent.slot} idle ${fmtMs(nowMs - Date.parse(agent.updatedAt))}`
      )
      .join("、")
    emergency.push(`agent 停滞：run-${runId.slice(0, 8)} ${detail}`)
    flush()
  }

  /** 清空队列与计时器（scheduler run teardown / service close）。 */
  function close(): void {
    clearTimer()
    timerDueAt = null
    for (const { timer } of stallTimers.values()) clearTimeout(timer)
    stallTimers.clear()
    lines.clear()
    emergency.length = 0
    notices.length = 0
  }

  /** 只读实时快照（agent dialog 收件箱 tab）：待 flush 积压 + 计时器
   * 状态。历史投递不入内（持久化在 scheduler_inbox_digests，由服务查询）。 */
  function snapshot() {
    return {
      pending: [...lines.entries()].map(([runId, events]) => ({
        runId,
        events: [...events],
      })),
      notices: [...notices],
      emergency: [...emergency],
      silence: { armed: timer !== null, flushAt: timerDueAt },
      stallWatch: [...stallTimers.entries()].map(([runId, { dueAt }]) => ({
        runId,
        dueAt,
      })),
    }
  }

  /** 现查 challenge 名。 */
  function challengeName(challengeId: string | null): string {
    if (!challengeId) return ""
    return (
      db
        .select({ name: challenges.name })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .get()?.name ?? ""
    )
  }

  /** 单 run digest 行的时间列（flush 时现查，静态快照）。行格式对齐设计：
   *  `running <elapsed> | deadline剩 X | 最近活动 X`
   *  `idle <闲置时长> | deadline剩 X`
   *  `closed | 耗时 X`
   * ⚠ 标注：active 且最近活动 > 25min（疑似停滞）；deadline 剩余 < 10min。 */
  function renderRunLine(row: typeof runs.$inferSelect, nowMs: number): string {
    const status = row.status
    const parts: string[] = []
    const warnings: string[] = []
    const lastActivity = nowMs - Date.parse(row.updatedAt)
    if (status === "closed") {
      parts.push("closed")
      if (row.startedAt) {
        const endMs = row.completedAt ? Date.parse(row.completedAt) : nowMs
        parts.push(`耗时 ${fmtMs(endMs - Date.parse(row.startedAt))}`)
      }
      return parts.join(" | ")
    }
    if (status === "running") {
      parts.push(
        row.startedAt
          ? `running ${fmtMs(nowMs - Date.parse(row.startedAt))}`
          : "running"
      )
      parts.push(`最近活动 ${fmtMs(lastActivity)}`)
    } else {
      parts.push(`idle ${fmtMs(lastActivity)}`)
    }
    if (row.deadlineAt) {
      const remain = Date.parse(row.deadlineAt) - nowMs
      if (remain >= 0) {
        parts.push(`deadline剩 ${fmtMs(remain)}`)
        if (remain < DEADLINE_NEAR_MS) warnings.push("⚠ 临近deadline")
      } else {
        parts.push(`deadline超 ${fmtMs(-remain)}`)
      }
    }
    if (lastActivity > STALL_MS) warnings.push("⚠ 停滞")
    return [...parts, ...warnings].join(" | ")
  }

  /** 组装 digest 文本（静态快照，全部现查；总有 header + 统计行）。 */
  function buildDigest(): string {
    const nowMs = Date.now()
    const clock = new Date(nowMs)
    const hh = String(clock.getHours()).padStart(2, "0")
    const mm = String(clock.getMinutes()).padStart(2, "0")
    const ss = String(clock.getSeconds()).padStart(2, "0")
    const out: string[] = [`[调度事件摘要 now=${hh}:${mm}:${ss}]`]

    // run 行（同 run 合并；前两列对齐；超出 MAX_RUN_LINES 折叠）。
    const rendered: Array<[string, string, string]> = []
    for (const [runId, events] of lines) {
      const row = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (!row) continue
      rendered.push([
        `run-${runId.slice(0, 8)}`,
        challengeName(row.challengeId),
        `${events.join("→")} | ${renderRunLine(row, nowMs)}`,
      ])
    }
    const idWidth = Math.max(0, ...rendered.map((r) => r[0].length))
    const nameWidth = Math.max(0, ...rendered.map((r) => r[1].length))
    const overflow = rendered.length - MAX_RUN_LINES
    const shown = overflow > 0 ? rendered.slice(0, MAX_RUN_LINES) : rendered
    for (const [shortId, name, rest] of shown) {
      out.push(
        `${shortId.padEnd(idWidth)} | ${name.padEnd(nameWidth)} | ${rest}`
      )
    }
    if (overflow > 0) out.push(`…另有 ${overflow} 个 run 事件`)

    // 普通通知行（队列 pause/resume 等）介于 run 行与紧急行之间。
    for (const line of notices) out.push(line)

    for (const line of emergency) out.push(`⚠ ${line}`)

    // 统计行：active X/cap · pending Y。
    const active = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.eventId, deps.eventId),
          eq(runs.scopeType, "challenge"),
          inArray(runs.status, ["running", "idle"])
        )
      )
      .all().length
    const cap = get(getSettings(), "scheduler.maxConcurrentRuns")
    const pending = db
      .select({ id: runQueue.id })
      .from(runQueue)
      .where(
        and(eq(runQueue.eventId, deps.eventId), eq(runQueue.status, "pending"))
      )
      .all().length
    out.push(`active ${active}/${cap} · pending ${pending}`)
    return out.join("\n")
  }

  /** 一次性结算：组装 digest → send（steer）→ 持久化投递历史 → 清空队列
   * 与计时器。 */
  function flush(): void {
    clearTimer()
    timerDueAt = null
    const digest = buildDigest()
    lines.clear()
    emergency.length = 0
    notices.length = 0
    db.insert(schedulerInboxDigests)
      .values({
        id: crypto.randomUUID(),
        eventId: deps.eventId,
        text: digest,
        createdAt: deps.now(),
      })
      .run()
    deps.send(digest)
  }

  return { push, pushEmergency, pushNotice, noteAgentIdle, close, snapshot }
}
