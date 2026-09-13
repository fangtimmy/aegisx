import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { parseJson } from "../lib/guards"

/**
 * Short-lived agent credentials. The host holds one per-boot HMAC secret;
 * every bash exec mints `{agentId, exp}` under it and agent-auth verifies the
 * bearer against the same secret + the agents row. No DB credential exists:
 * a stolen token dies within the TTL, and a restart invalidates every
 * outstanding token (exec is a runtime phenomenon — nothing to migrate).
 */

/** 2× the 1800s bash exec hard ceiling — covers exec-derived process trees
 * (nohup'd children inherit the env) with margin. */
export const AGENT_TOKEN_TTL_SEC = 3600

const SECRET = randomBytes(32)

const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("base64url")

/** Mint one bearer token for `agentId`, valid for AGENT_TOKEN_TTL_SEC. */
export function mintAgentToken(agentId: string): string {
  const body = Buffer.from(
    JSON.stringify({
      agentId,
      exp: Math.floor(Date.now() / 1000) + AGENT_TOKEN_TTL_SEC,
    })
  ).toString("base64url")
  return `${body}.${sign(body)}`
}

/** Verify signature + expiry; null when tampered, expired or malformed. */
export function verifyAgentToken(token: string): { agentId: string } | null {
  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const expected = Buffer.from(sign(body), "base64url")
  const got = Buffer.from(token.slice(dot + 1), "base64url")
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return null
  }
  try {
    const payload = parseJson<{
      agentId?: unknown
      exp?: unknown
    }>(Buffer.from(body, "base64url").toString())
    if (
      typeof payload.agentId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp * 1000 <= Date.now()
    ) {
      return null
    }
    return { agentId: payload.agentId }
  } catch {
    return null
  }
}
