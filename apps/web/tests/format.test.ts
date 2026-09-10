import { describe, expect, test } from "bun:test"

import {
  formatDurationClock,
  formatHourMinute,
  formatTimeWithSeconds,
} from "@/lib/format"

// Local-time construction keeps these assertions timezone-independent.
const at = (h: number, m: number, s = 0) =>
  new Date(2026, 2, 5, h, m, s).getTime()

describe("formatHourMinute", () => {
  test("renders 24-hour HH:mm", () => {
    expect(formatHourMinute(at(14, 5))).toBe("14:05")
    expect(formatHourMinute(at(9, 7))).toBe("09:07")
    expect(formatHourMinute(at(0, 0))).toBe("00:00")
  })

  test("null when unset or invalid", () => {
    expect(formatHourMinute(undefined)).toBeNull()
    expect(formatHourMinute("not-a-date")).toBeNull()
  })
})

describe("formatTimeWithSeconds", () => {
  test("renders 24-hour HH:mm:ss", () => {
    expect(formatTimeWithSeconds(at(14, 5, 3))).toBe("14:05:03")
  })
})

describe("formatDurationClock", () => {
  test("m:ss under an hour, h:mm:ss beyond, clamped at zero", () => {
    expect(formatDurationClock(90_000)).toBe("1:30")
    expect(formatDurationClock(3_600_000)).toBe("1:00:00")
    expect(formatDurationClock(-1_000)).toBe("0:00")
  })
})
