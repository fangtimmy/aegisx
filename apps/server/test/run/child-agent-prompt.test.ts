import { describe, expect, test } from "bun:test"

import type { PromptContext } from "../../src/orchestration/types"
import { renderChildSystemPrompt } from "../../src/run/child-agents"

const runCtx: PromptContext = {
  event: { id: "e1", name: "Ev", platform: "ctfd", promptHint: "" },
  challenge: {
    id: "c1",
    name: "Ch",
    description: "d",
    category: "web",
    points: 100,
    attachments: [],
    attachmentPaths: [],
  },
  model: { provider: "P", name: "M", id: "m" },
  run: {
    id: "run-1",
    environment: "container",
    isContainer: true,
    workspace: "/workspace",
    targetSupported: true,
    platformIntegrated: true,
    containerImage: "img",
    cpus: 2,
    memoryMb: 1024,
    pidsLimit: 128,
  },
  // Run-level caps are all true — a child must still render with zeroed caps.
  capabilities: {
    canFinish: true,
    canSubmitFlag: true,
    canManageTarget: true,
    canSpawn: true,
  },
}

describe("renderChildSystemPrompt (spec §3.7 spawn caps)", () => {
  test("child context carries role/name/task and ZEROED capabilities", () => {
    const out = renderChildSystemPrompt(
      "C {{agent.role}} {{agent.name}} task={{agent.task}} f={{capabilities.canFinish}} s={{capabilities.canSpawn}} submit={{capabilities.canSubmitFlag}} t={{capabilities.canManageTarget}}",
      runCtx,
      "Worker",
      "extract the cipher"
    )
    expect(out).toBe(
      "C child Worker task=extract the cipher f=false s=false submit=false t=false"
    )
  })

  test("run-level context (challenge/event/model) still renders", () => {
    const out = renderChildSystemPrompt(
      "on {{challenge.name}} via {{model.id}}",
      runCtx,
      "Worker",
      ""
    )
    expect(out).toBe("on Ch via m")
  })
})
