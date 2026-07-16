export function json(method: "POST" | "PUT" | "PATCH", body: unknown) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

export async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 8_000
) {
  const deadline = Date.now() + timeout
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state")
    await Bun.sleep(25)
  }
}
