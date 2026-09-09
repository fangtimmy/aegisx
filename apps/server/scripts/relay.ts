/**
 * Strip-path reverse proxy for fixed-endpoint LLM gateways (e.g. the DASCTF
 * proxy URL that must be used verbatim, with no path appended). Any request
 * path is dropped; method, headers, and streaming body are forwarded to the
 * upstream URL as-is, and the response (including SSE) is streamed back.
 *
 * Usage: bun run relay <upstream-url> [port]
 * Then point an AegisX provider at http://127.0.0.1:<port>/v1 with the
 * upstream's API key.
 */
const [upstream, portArg] = process.argv.slice(2)
if (!upstream) {
  console.error("Usage: bun run relay <upstream-url> [port]")
  process.exit(1)
}

const port = Number(portArg ?? 8788)

Bun.serve({
  port,
  // Bun's default 10s idle timeout kills LLM streams that pause between chunks.
  idleTimeout: 255,
  async fetch(req) {
    const headers = new Headers(req.headers)
    headers.delete("host")
    headers.delete("content-length")
    try {
      const res = await fetch(upstream, {
        method: req.method,
        headers,
        body:
          req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        signal: req.signal,
        // Keep the body bytes as-is so forwarded headers (content-encoding,
        // content-length) stay truthful — Bun's auto-decompress would emit
        // plain bytes still labeled `content-encoding: gzip`.
        decompress: false,
      })
      console.log(`${req.method} ${new URL(req.url).pathname} -> ${res.status}`)
      return new Response(res.body, res)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`relay: upstream unreachable (${message})`, {
        status: 502,
      })
    }
  },
})

console.log(`relay: http://127.0.0.1:${port} -> ${upstream}`)
