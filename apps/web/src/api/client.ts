import { isRecord } from "@aegisx/shared"

/** Server errors carry { error: { code, message } } — preserve the code
 * so views can branch on it (e.g. target `not_bound`). */
export class ApiError extends Error {
  readonly code: string | undefined

  constructor(message: string, code: string | undefined) {
    super(message)
    this.code = code
  }
}

function readErrorBody(body: unknown): { message?: string; code?: string } {
  if (!isRecord(body) || !isRecord(body.error)) return {}
  return {
    message:
      typeof body.error.message === "string" ? body.error.message : undefined,
    code: typeof body.error.code === "string" ? body.error.code : undefined,
  }
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`/api${path}`, init)

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    let code: string | undefined

    try {
      const { message: errorMessage, code: errorCode } = readErrorBody(
        await response.json()
      )
      if (errorMessage) message = errorMessage
      code = errorCode
    } catch {
      // Keep the HTTP status when the server does not return its JSON error shape.
    }

    throw new ApiError(message || "The request failed", code)
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- typed-RPC boundary: T is the caller's declared view of the endpoint contract.
  if (response.status === 204) return undefined as T
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- typed-RPC boundary: response body is trusted to match T per the endpoint contract.
  return response.json() as Promise<T>
}

export function jsonRequest(method: "POST" | "PUT" | "PATCH", body: object) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } satisfies RequestInit
}
