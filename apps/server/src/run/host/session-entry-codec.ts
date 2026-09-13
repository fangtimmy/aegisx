/**
 * Canonical session-entry codec (E): the owned data shape behind the
 * `session_entries.body` column. pi's `SessionEntry` is the in-memory shape;
 * this is the persisted one — declared here so pi's type evolution hits this
 * file's conversion functions, not the store.
 *
 * Envelope: `{ kind, ...typedFields, payload }`
 *  - `kind` — canonical kind, registry-declared (same technique as the
 *    domain-events registry). For known kinds it mirrors the pi entry type.
 *  - typed fields — the per-kind fields we treat as canonical (the registry's
 *    declaration); the queryable ones (id/parent/timestamp/role/tool_name/
 *    usage) became `session_entries` COLUMNS instead.
 *  - `payload` — the pi-specific remainder (message content blocks, toolCall
 *    payloads, compaction details, usage objects), stored verbatim so
 *    unknown-shape fields survive the round trip.
 *
 * Unknown kinds are default-accepted: the whole entry remainder goes into
 * `payload` and comes back byte-equal on resume.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent"

import { parseJson } from "../../lib/guards"

/** Per-kind canonical typed fields (everything NOT here and NOT a base field
 * lands in `payload`). Mirrors pi's SessionEntry interfaces at 0.85.1. */
const KIND_TYPED_FIELDS = {
  message: [],
  compaction: ["summary", "firstKeptEntryId", "tokensBefore", "fromHook"],
  branch_summary: ["fromId", "summary", "fromHook"],
  model_change: ["provider", "modelId"],
  thinking_level_change: ["thinkingLevel"],
  custom: ["customType"],
  custom_message: ["customType", "display"],
  session_info: ["name"],
  label: ["targetId", "label"],
} as const satisfies Record<string, readonly string[]>

/** Entry base fields that live in dedicated columns, never in the body. */
const BASE_FIELDS = ["id", "parentId", "timestamp", "type"] as const

/** The canonical body shape. Typed fields are kind-dependent; `payload` is
 * always the verbatim remainder. */
export type CanonicalEntryBody = {
  kind: string
  payload: Record<string, unknown>
} & Record<string, unknown>

/** Canonicalize one pi entry into the persisted body envelope. */
export function toCanonicalBody(entry: SessionEntry): CanonicalEntryBody {
  // The entry union has no index signature; crossing into a plain record is
  // the conversion's whole point (the codec is the pi-shape boundary).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SessionEntry → plain record at the pi boundary
  const record = entry as unknown as Record<string, unknown>
  const rest = omit(record, [...BASE_FIELDS])
  const typed = KIND_TYPED_FIELDS[entry.type]
  if (!typed) {
    // Unknown kind: default-accept — store the remainder verbatim.
    return { kind: entry.type, payload: rest }
  }
  const body: CanonicalEntryBody = { kind: entry.type, payload: {} }
  for (const field of typed) {
    if (field in rest) body[field] = rest[field]
  }
  body.payload = omit(rest, [...typed])
  return body
}

/** Rebuild one pi entry from its row: id/parent/timestamp come from the
 * row's columns, kind + typed fields + payload from the body. */
export function entryFromRow(row: {
  id: string
  parentId: string | null
  createdAt: string
  body: string
}): SessionEntry {
  const parsed = parseJson<CanonicalEntryBody>(row.body)
  const { kind, payload, ...typed } = parsed
  // Rows are written by the adapter (typed at commit time); the rebuild
  // trusts the canonical envelope.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- canonical envelope → pi entry at the pi boundary
  return {
    ...typed,
    ...payload,
    type: kind,
    id: row.id,
    parentId: row.parentId,
    timestamp: row.createdAt,
  } as unknown as SessionEntry
}

function omit(
  record: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) out[key] = record[key]
  }
  return out
}
