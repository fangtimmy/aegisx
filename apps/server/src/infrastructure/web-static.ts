import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import type { Hono } from "hono"

/**
 * Serve the built web SPA from the server process (single-image appliance
 * mode, enabled by AEGISX_WEB_DIR). Registered after the /api routes:
 * unknown /api paths 404, everything else resolves a file under the web root
 * or falls back to index.html (client-side routing).
 */
export function registerWebApp(app: Hono, webDir: string) {
  const root = resolve(webDir)
  const index = join(root, "index.html")
  app.get("*", (c) => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname)
    } catch {
      // Malformed percent-encoding is a bad request path, not a server fault.
      return c.notFound()
    }
    if (pathname.startsWith("/api/")) return c.notFound()
    const candidate = join(root, pathname)
    if (!underRoot(candidate, root)) return c.notFound()
    const file =
      existsSync(candidate) && statSync(candidate).isFile() ? candidate : index
    if (!existsSync(file)) return c.notFound()
    return new Response(Bun.file(file))
  })
}

function underRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}
