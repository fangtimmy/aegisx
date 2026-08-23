export function json(method: "POST" | "PUT" | "PATCH", body: unknown) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

/**
 * Test-only refinement seam: narrows a partial stub or a captured call value
 * to the shape the test cares about. Centralizes what would otherwise be
 * dozens of scattered `as unknown as` casts around fixture objects. (`T`
 * appears only in the return position by design.)
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function refine<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T
}
