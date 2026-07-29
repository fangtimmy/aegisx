import type { Hono } from "hono"

type ErrorContext = Parameters<Parameters<Hono["onError"]>[0]>[1]
type ErrorStatus = 400 | 404 | 409 | 500 | 502

export function jsonError(
  c: ErrorContext,
  error: { code: string; message: string },
  status: ErrorStatus
) {
  return c.json({ error }, status)
}

export function notFound(c: ErrorContext, message: string) {
  return jsonError(c, { code: "not_found", message }, 404)
}
