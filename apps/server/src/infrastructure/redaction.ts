export function replaceText<T>(
  value: T,
  search: string,
  replacement: string
): T {
  if (!search) return value
  if (typeof value === "string") {
    return value.replaceAll(search, replacement) as T
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = replaceText(value[index], search, replacement)
    }
    return value
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      record[key] = replaceText(record[key], search, replacement)
    }
  }
  return value
}

export function redactSecrets<T>(value: T, secrets: Iterable<string>): T {
  let redacted = value
  for (const secret of secrets) {
    redacted = replaceText(redacted, secret, "[redacted]")
  }
  return redacted
}
