import { describe, expect, test } from "bun:test"

import {
  previewInitialPrompt,
  previewSystemPrompt,
  renderSystemPrompt,
  samplePromptContext,
} from "../../src/orchestration/prompt-templates"

const highlightedText = (segments: { highlighted: boolean; text: string }[]) =>
  segments.filter((s) => s.highlighted).map((s) => s.text)

describe("prompt preview", () => {
  test("highlights interpolated variable values", () => {
    const segments = previewSystemPrompt(
      "Solve {{challenge.name}} ({{challenge.category}})",
      samplePromptContext
    )
    expect(highlightedText(segments)).toContain("Encrypted Notes")
    expect(highlightedText(segments)).toContain("web")
  })

  test("marks bare true/false tokens as highlighted even outside variables", () => {
    const segments = previewSystemPrompt(
      "Container: {{run.isContainer}} submit: {{capabilities.canSubmitFlag}}",
      samplePromptContext
    )
    // booleans are not marker-wrapped by markPreviewValues, but previewSegments
    // splits bare true/false tokens out and highlights them.
    expect(highlightedText(segments)).toContain("true")
  })

  test("returns a single non-highlighted segment for static text", () => {
    const segments = previewSystemPrompt("Static text", samplePromptContext)
    expect(segments).toHaveLength(1)
    expect(segments[0].highlighted).toBe(false)
  })

  test("initial prompt preview mirrors system prompt segmentation", () => {
    const segments = previewInitialPrompt(
      "Begin {{challenge.name}}",
      samplePromptContext
    )
    expect(
      segments.some((s) => s.highlighted && s.text === "Encrypted Notes")
    ).toBe(true)
  })

  test("preview and plain render agree on the non-marker text", () => {
    const template = "Task: {{challenge.name}} @ {{run.workspace}}"
    const plain = renderSystemPrompt(template, samplePromptContext)
    const joined = previewSystemPrompt(template, samplePromptContext)
      .map((s) => s.text)
      .join("")
    expect(joined).toBe(plain)
  })
})
