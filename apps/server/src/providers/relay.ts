import type { Hono } from "hono"

import type { ConfigStore } from "../infrastructure/config-store"
import { jsonError, notFound } from "../infrastructure/http-errors"

/**
 * Verbatim forwarder for exact-endpoint gateway providers. Some competition
 * gateways hand out a URL that already encodes the complete upstream path
 * (the token IS the endpoint), while the OpenAI/Anthropic SDKs behind pi-ai
 * always append their API suffix to baseUrl. models.json therefore points
 * those providers at this route, which swallows the suffix: whatever arrives
 * here is forwarded to the provider's baseUrl unchanged, and the upstream
 * response (SSE included) streams back untouched.
 *
 * User-face by design and registered before the agent-auth middleware: the
 * loopback caller carries the provider's gateway key as its Bearer token,
 * which is not an agent token. The destination is fixed by server config, so
 * the route exposes nothing beyond what the rest of the unauthenticated
 * localhost API already exposes (the provider apiKey itself).
 */

/** Hop-by-hop / transport headers that must not cross the proxy boundary —
 * fetch re-derives them for each new connection. */
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]

export function registerProviderRelayRoutes(
  app: Hono,
  options: { configStore: ConfigStore }
) {
  const { configStore } = options

  app.all("/api/llm-relay/:providerId/*", async (c) => {
    const provider = configStore
      .getProviders()
      .find((p) => p.id === c.req.param("providerId"))
    if (!provider?.exactEndpoint || !provider.baseUrl) {
      return notFound(c, "Provider not found")
    }
    const headers = new Headers(c.req.raw.headers)
    for (const header of HOP_HEADERS) headers.delete(header)
    const body =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? undefined
        : await c.req.arrayBuffer()
    let upstream: Response
    try {
      upstream = await fetch(provider.baseUrl, {
        method: c.req.method,
        headers,
        body,
        signal: c.req.raw.signal,
      })
    } catch (error) {
      return jsonError(
        c,
        {
          code: "provider_unavailable",
          message: `Gateway unreachable: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 300),
        },
        502
      )
    }
    const responseHeaders = new Headers(upstream.headers)
    for (const header of HOP_HEADERS) responseHeaders.delete(header)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  })
}
