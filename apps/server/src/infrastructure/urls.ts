/**
 * Validate + canonicalize an HTTP(S) base URL.
 *
 * Centralizes URL parsing and trailing-slash trimming so every entry point
 * (provider settings, platform binding, PlatformHttp) shares one definition.
 * Callers wrap the thrown {@link Error} into whatever domain error type they
 * surface to the API.
 *
 * @throws {Error} when the value is not a parseable HTTP(S) URL.
 */
export function normalizeHttpBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use HTTP or HTTPS")
  }
  return url.toString().replace(/\/$/, "")
}
