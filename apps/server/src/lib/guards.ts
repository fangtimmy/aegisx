import { isRecord } from "@aegisx/shared"

/** Narrow to a record or undefined (for optional/loose payload fields). */
export function optRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/**
 * Typed JSON.parse. The standard library types the result as `any`; every
 * other path would need this exact assertion anyway, so it lives here —
 * call sites own the payload shape contract. (`T` appears only in the return
 * position by design: callers name the shape explicitly at the call site.)
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function parseJson<T>(raw: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(raw) as T
}

/**
 * Typed body read for anything exposing `.json()` (Bun's `Response` types it
 * as `Promise<any>`; Hono's `HonoRequest` the same). Same seam model as
 * {@link parseJson}: call sites own the payload shape contract.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export async function responseJson<T>(source: {
  json(): Promise<unknown>
}): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await source.json()) as T
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
