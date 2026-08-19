/** Server errors carry { error: { code, message } } — preserve the code
 * so views can branch on it (e.g. target `not_bound`). */
export class ApiError extends Error {
  readonly code: string | undefined

  constructor(message: string, code: string | undefined) {
    super(message)
    this.code = code
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
      const body = (await response.json()) as {
        error?: { code?: string; message?: string }
      }
      if (body.error?.message) message = body.error.message
      code = body.error?.code
    } catch {
      // Keep the HTTP status when the server does not return its JSON error shape.
    }

    throw new ApiError(message || "The request failed", code)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function jsonRequest(method: "POST" | "PUT" | "PATCH", body: object) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } satisfies RequestInit
}
