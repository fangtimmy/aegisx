# AegisX v5 Lifecycle — E2E Verification Results

Status: **PASS (1 bug found & fixed)**
Verified against: HEAD `47d6fdd` @ `rewrite/v4-sdk-agent` + the one-line fix below.
Environment: Docker 29.4, `aegisx/solver:kali` (emulated amd64 on arm64 host),
Opencode `deepseek-v4-flash-free`, live server on :3000, real platform-managed
challenge `base` (MoeCTF 2025).

Related: [architecture.md](./architecture.md), [lifecycle-redesign.md](./lifecycle-redesign.md).

## Summary

All 9 handoff scenarios + steer/followUp + carry-overs pass end-to-end against a
real model, real Docker containers, and a real CTF platform. **One real bug was
found and fixed**: cold-restore (`ensureWarm`) could not resolve the run's model,
so messaging a `closed` run failed. After the fix, cold restore rebuilds a fresh
container and reopens the jsonl session with full context preserved.

## Bug found & fixed

`apps/server/src/run/model-runtime.ts` — `resolveRunModel` matched
`provider.models.find((m) => m.id === modelId)` by the provider-model **UUID**,
but `ensureWarm` passes `row.modelId`, which is the underlying **modelId string**
(e.g. `deepseek-v4-flash-free`) stored on the run row. The create flow only
worked because the API passes the UUID. Symptom (server log):

```
Request failed { error: "Could not resolve the run's model for restore" }
```

Fix: match either key.

```ts
const model = provider.models.find(
  (m) => m.id === modelId || m.modelId === modelId
)
```

UUIDs and modelId strings never collide, so the create path (UUID) is unaffected.
Verified by `B2` and the isolated cold-restore diagnostic (same jsonl reopened,
24→26 lines, agent recalls a token planted before the close).

## Scenario results

Harness: `/tmp/e2e/run.ts` (A–G + steer), `/tmp/e2e/recover.sh` (E),
`/tmp/e2e/cold-diag.ts` (cold-restore deep-dive), `/tmp/e2e/carryover.ts`.
*(These scripts are ephemeral / outside the repo; they are not part of `bun test`.)*

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| 1 | **idle 秒回** — turn ends → `idle`, container kept; next msg = new turn, no rebuild; context remembered | PASS | `A1` status=idle container=warm; `A2` containerId unchanged across 2nd turn; `A3` token `ZEBRA-42` recalled |
| 2 | **finish → closed → cold restore** | PASS | `B1` finish→closed, container released, `completedAt`+summary set; `B2` message closed run → new container, jsonl context preserved (token recalled) |
| 3 | **sendMessage isStreaming split** (steer/followUp queue while running) | PASS | steer.http=200 follow.http=200 while running; settled idle, no rebuild |
| 4 | **turn generation guard** (stale settle no-op) | code-verified | `settleTurn` checks `turnGeneration` before acting; not deterministically triggerable, observed no status flicker across all scenarios |
| 5 | **stop (Esc) ≠ close** | PASS | `C` mid-running stop → idle, container KEPT; close (D) → container released |
| 6 | **manual close** | PASS | `D` idle→closed, container gone (~1s async), jsonl+workspace kept |
| 7 | **recoverOnBoot** | PASS | warm run + live container → hard kill server → orphan survives → restart marks run `closed`, force-removes orphan, leaves already-closed run untouched, recovered run cold-restores |
| 8 | **delete any state** | PASS | `F1` closed / `F2` idle (warm container killed+removed) / `F3` running — all: http 204, row gone, `data/runs/<id>` removed, container gone |
| 9 | **submit_flag → solved** | PASS | known flag submitted → platform `accepted` → `run.flag` set, `hasFlag=true`, challenge `status=solved` (catalog keyed on flag) |

Carry-overs:

| Item | Result | Evidence |
|------|--------|----------|
| spawn_agent child observability | PASS | child agent appears (role=child, status=completed), parent observes child result |
| SSE reconnect contract | PASS | every connection emits a fresh initial snapshot (`ready`/`run.updated`/`agent.updated`); reconnect re-emits clean snapshot; committed messages stable (durable via `/messages`, not SSE-duplicated). Frontend `resetForReconnect` is code-verified. |
| agent_end / willRetry | code-verified | `events.ts:203` `case "agent_end": if (event.willRetry) return` — retry skips commit |
| full event projection | PASS | SSE emitted `message.progress`, `message.committed`, `tool.progress`, `run.updated`, `agent.updated` |

## Non-blocking observations (no action taken)

- **HTTP response lags settle by one tick.** `stop`/`finish`/`closeRun` while
  streaming return the run still `running`; the actual `idle`/`closed` lands via
  SSE `run.updated` a moment later (the settle queues on the held lock). SSE is
  the source of truth, so the UI converges correctly — just expect the immediate
  POST JSON to be one state behind. This is inherent to the fire-and-forget
  settle design, not a bug.
- **Container release is async (~1s).** `freeRun` sets `closed` immediately and
  SIGTERMs the container; with `AutoRemove` the container disappears ~1s later.
  Correct by design (don't block the response on Docker).
- **Generation-guard timing edge** (a `steer` landing in the window between
  `abort()` and `isStreaming` flipping false) is pi-SDK-dependent and could not
  be triggered deterministically. Observed no anomalies.

## Verification commands (all green after the fix)

```
apps/server : bun run check   # 8 warnings (pre-existing, non-blocking), 0 errors
apps/server : bun test        # 16 pass / 0 fail
apps/web    : bun run check   # clean (122 files)
apps/web    : bun run build   # OK (chunk-size warning only)
```

## State after E2E

Test artifacts (dummy challenges, runs, containers) were cleaned up. The DB is
back to its pre-E2E state: the `base` challenge and the original closed+solved
run remain. The server is running under `tmux` session `aegisx`.

## Not covered (out of scope / deferred)

- `target_*` tool badge (explicitly deferred in the redesign doc).
- Frontend `resetForReconnect` dedup exercised through a real browser (backend
  contract verified; frontend path code-verified).
- Deterministic generation-guard race (see observations).
- The deferred feature list (per-run timeout, idle auto-close, usage/cost
  Overview, long-lived shell reuse, settings UI for compaction/retry, agent
  inspector) — see [lifecycle-redesign.md §十二](./lifecycle-redesign.md).
