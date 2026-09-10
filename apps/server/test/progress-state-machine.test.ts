import { describe, expect, test } from "bun:test"

import { progressOf, type ChallengeProgressInputs } from "@aegisx/shared"

/** Baseline inputs: a platform-integrated single-flag challenge with nothing
 * accepted. Each test overrides only what it exercises. */
function inputs(
  overrides: Partial<ChallengeProgressInputs> = {}
): ChallengeProgressInputs {
  return {
    accepted: 0,
    requiredFlags: null,
    remoteSolved: false,
    integrated: true,
    manual: "unsolved",
    points: null,
    ...overrides,
  }
}

describe("challenge progress state machine", () => {
  test("a KNOWN single-flag requirement makes partial unreachable", () => {
    for (const accepted of [0, 1, 5]) {
      for (const remoteSolved of [false, true]) {
        for (const manual of ["unsolved", "partial", "solved"] as const) {
          const { state } = progressOf(
            inputs({ requiredFlags: 1, accepted, remoteSolved, manual })
          )
          if (state === "partial") {
            // Only the manual override may produce partial when required === 1.
            expect(manual).toBe("partial")
          }
        }
      }
    }
  })

  test("an unknown requirement count can never claim solved from the count", () => {
    // The platform has not said how many flags exist, so an accepted row only
    // proves partial — claiming solved would skip a chain's remaining flags.
    for (const accepted of [1, 5, 50]) {
      const p = progressOf(inputs({ requiredFlags: null, accepted }))
      expect(p.state).toBe("partial")
    }
  })

  test("unsolved → partial → solved across a multi-flag chain", () => {
    const chain = (accepted: number) =>
      progressOf(inputs({ requiredFlags: 6, accepted })).state
    expect(chain(0)).toBe("unsolved")
    expect(chain(1)).toBe("partial")
    expect(chain(5)).toBe("partial")
    expect(chain(6)).toBe("solved")
  })

  test("integrated + accepted flag + unknown count stays partial (never solved)", () => {
    const p = progressOf(inputs({ requiredFlags: null, accepted: 1 }))
    expect(p.state).toBe("partial")
    expect(p.source).toBe("count")
  })

  test("remote verdict wins over an unconfirmed local count", () => {
    const p = progressOf(
      inputs({ requiredFlags: 6, accepted: 1, remoteSolved: true })
    )
    expect(p.state).toBe("solved")
    expect(p.source).toBe("remote")
  })

  test("non-integrated: an accepted flag IS the local verdict", () => {
    const p = progressOf(inputs({ integrated: false, accepted: 1 }))
    expect(p.state).toBe("solved")
    expect(p.source).toBe("local")
  })

  test("manual override outranks every derived dimension", () => {
    expect(
      progressOf(inputs({ requiredFlags: 6, accepted: 6, manual: "unsolved" }))
        .state
    ).toBe("solved") // count reached → solved regardless of manual=unsolved
    expect(progressOf(inputs({ accepted: 0, manual: "solved" })).state).toBe(
      "solved"
    )
    expect(
      progressOf(inputs({ accepted: 6, remoteSolved: true, manual: "partial" }))
        .state
    ).toBe("partial")
  })

  test("requiredFlags arriving later downgrades solved → partial (T4)", () => {
    const before = progressOf(inputs({ requiredFlags: 1, accepted: 1 }))
    expect(before.state).toBe("solved")
    // A re-sync reveals the challenge actually requires six flags.
    const after = progressOf(inputs({ requiredFlags: 6, accepted: 1 }))
    expect(after.state).toBe("partial")
  })

  test("requiredFlags shrinking completes the chain (T8)", () => {
    const p = progressOf(inputs({ requiredFlags: 1, accepted: 3 }))
    expect(p.state).toBe("solved")
    // Confirmed progress never exceeds the requirement.
    expect(p.confirmed).toBe(1)
  })

  test("yield figures derive from the per-flag split", () => {
    const p = progressOf(inputs({ requiredFlags: 6, accepted: 2, points: 600 }))
    expect(p.perFlag).toBe(100)
    expect(p.earned).toBe(200)
    expect(progressOf(inputs({ points: null })).earned).toBeNull()
  })
})
