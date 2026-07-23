# AegisX Architecture v2

Status: **complete** (Phases 0–6 + post-cut stats/tests/queries)  
Branch: `rewrite/v2`  
Last updated: 2026-07-23

## Principles

1. One source of truth per concept (status, message, config).
2. Pure state machine + thin side effects (`run/machine.ts` + `run/service.ts`).
3. Fewer concepts over more files.
4. Unidirectional deps: `http → service → machine | store | runtime`.
5. Persist shape ≈ wire shape (`Message` / `LiveEvent` in `apps/shared`).
6. Crash recovery without auto-calling the model.
7. No multi-tenant, queue, CQRS, or custom agent loop.

## Product rules

- Event → Challenge → Run → Agents (exactly one main, zero or more children).
- Only main: user messages, `spawn_agent`, `finish_run`, target tools.
- Children cannot spawn; shared workspace/model/env per run.
- `maxConcurrency` = agents in `running` ∪ `idle`.
- Platform targets are never auto-started or auto-stopped with a run.

## Hard decisions

| ID | Decision |
|----|----------|
| D1 | SSE is **live only** (no `run_events`, no durable cursor). |
| D2 | One `messages` table; no `agent_inbox`. |
| D3 | Run id ≠ main agent id. |
| D4 | Frozen `model_json` / `env_json` / `prompt_json` on `runs`. |
| D5 | Single pure reducer owns lifecycle transitions. |
| D6 | No v1 DB migration — wipe `data/`. |
| D7 | Full-stack contract change. |
| D8 | Successful run = `completed` **and** has flag (stats/UI). |
| D9 | Event stats `tools[]` empty (no tool_calls table). |
| D10 | Platform flag write is a side path; `refresh` broadcasts only. |

## Layout

```text
apps/server/src/
  run/       machine, service, queries, public, store, session, tools, routes, live, stats
  agent/     runtime, tools, usage, compact, convert, managed-tools
  platforms/ adapters + bind/sync/submit/target
  providers/ model registry
  settings/  prompts + runtime settings
  events/    catalog routes
  db/        schema v2 + wipe guard
apps/shared/ wire types
apps/web/    api + live stream store + features
```

## Known limitations

- Live SSE only — reconnect uses REST message page, not event cursor.
- Event stats omit per-tool analytics (`tools: []`).

## API (run)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/challenges/:id/runs` | create |
| GET | `/api/runs/:id` | `{ run, agents, usage }` |
| GET | `/api/runs/:id/messages` | `?agentId&after=` |
| GET | `/api/runs/:id/stream` | live SSE |
| POST | `/api/runs/:id/message` | user message |
| POST | `/api/runs/:id/pause\|resume\|stop` | control |
| DELETE | `/api/runs/:id` | terminal only |

## Wipe / upgrade

v1 databases are refused at open. Delete `data/aegisx.sqlite` or the whole `data/` directory.

## Phases

| Phase | Status |
|-------|--------|
| 0 Design freeze | done |
| 1 Shared + schema | done |
| 2 machine/store/service | done |
| 3 runtime/session/tools | done |
| 4 HTTP + app wiring | done |
| 5 Web stream + Message | done |
| 6 Delete v1 stack + tests/docs | done |

## Success criteria

- Lifecycle explained by `machine.ts` + `service.ts` + `agent/runtime.ts`.
- One Message type, one live event model, one status reducer.
- Server + web unit tests green on v2 paths.
