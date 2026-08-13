import type { Context } from "hono"

type ErrorStatus = 400 | 404 | 409 | 413 | 415 | 429 | 500 | 502

export function jsonError(
  c: Context,
  error: { code: string; message: string },
  status: ErrorStatus
) {
  return c.json({ error }, status)
}

/** 400 — request failed validation or carried invalid domain data. */
export function badRequest(c: Context, code: string, message: string) {
  return jsonError(c, { code, message }, 400)
}

/** 404 — referenced resource does not exist. */
export function notFound(c: Context, message: string) {
  return jsonError(c, { code: "not_found", message }, 404)
}

/** 409 — request conflicts with current resource state. */
export function conflict(c: Context, code: string, message: string) {
  return jsonError(c, { code, message }, 409)
}

/** 413 — request body exceeded a size budget. */
export function payloadTooLarge(c: Context, code: string, message: string) {
  return jsonError(c, { code, message }, 413)
}

/** 415 — request content type is not supported. */
export function unsupportedMediaType(
  c: Context,
  code: string,
  message: string
) {
  return jsonError(c, { code, message }, 415)
}

export type { Context }
