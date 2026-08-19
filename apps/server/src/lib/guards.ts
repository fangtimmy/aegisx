export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Stringify a loosely-typed JSON field: primitives via String(), objects
 * via JSON.stringify (never "[object Object]"). */
export function jsonText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? ""
    } catch {
      return ""
    }
  }
  return String(value)
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
