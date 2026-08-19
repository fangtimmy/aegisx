import { useSyncExternalStore } from "react"

export type MarkdownArea = "user" | "assistant" | "thinking" | "system"

export type MarkdownPrefs = Record<MarkdownArea, boolean>

const STORAGE_KEY = "markdown-prefs"

const DEFAULTS: MarkdownPrefs = {
  user: false,
  assistant: true,
  thinking: false,
  system: false,
}

const AREAS: MarkdownArea[] = ["user", "assistant", "thinking", "system"]

function isPrefs(value: unknown): value is MarkdownPrefs {
  return (
    typeof value === "object" &&
    value !== null &&
    AREAS.every((area) => typeof (value as MarkdownPrefs)[area] === "boolean")
  )
}

function load(): MarkdownPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (isPrefs(parsed)) return parsed
    }
  } catch {
    // unreadable or corrupted storage: fall back to defaults
  }
  return DEFAULTS
}

let prefs = load()
const listeners = new Set<() => void>()

export function subscribeMarkdownPrefs(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getMarkdownPrefs(): MarkdownPrefs {
  return prefs
}

export function setMarkdownPrefs(next: Partial<MarkdownPrefs>) {
  prefs = { ...prefs, ...next }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  for (const listener of listeners) listener()
}

export function useMarkdownPrefs(): [
  MarkdownPrefs,
  (next: Partial<MarkdownPrefs>) => void,
] {
  const current = useSyncExternalStore(
    subscribeMarkdownPrefs,
    getMarkdownPrefs,
    getMarkdownPrefs
  )
  return [current, setMarkdownPrefs]
}
