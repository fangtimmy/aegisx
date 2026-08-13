# AegisX Architecture

Status: **superseded by v8** — the authoritative architecture is
[orchestration-redesign.md](./orchestration-redesign.md) (统一 Run + 编排插件,
schema v8, implemented P0–P5). This document describes the v4–v6 host-side SDK
agent model and is kept for history.

Related: [refactor-v4.md](./refactor-v4.md) is the v3→v4 transition plan (host-side SDK agent).

## What v4 is

A run is driven by a **host-side pi SDK `AgentSession`** (in-process). The agent
loop, visibility, compaction, retry, and child agents are first-party SDK
features. The Docker container is a **long-lived Kali tool box** (`sleep
infinity`); `bash` is forwarded into it over `docker exec`, and the file tools
operate on the host workspace (bind-mounted into the container so both sides
share one tree).

There is no PTY, no in-container `pi` process, no `ghostty-web`. The browser
shows a **Conversation** (structured message timeline + streaming) and steers
the agent with `steer` / `followUp` messages.

Server responsibilities:

1. Build an isolated host-side pi `ModelRuntime` + `AgentSession` per run (main
   agent), and child sessions on `spawn_agent`.
2. Orchestrate the tool-box container (create/start/kill/remove) and forward
   bash over `docker exec`.
3. Register native CTF tools (`submit_flag`, `finish_run`, `target_*`,
   `spawn_agent`) that call the platform service in-process.
4. Project SDK events → committed entries (SQLite `session_entries`) + ephemeral
   live progress (SSE) for the Conversation UI.
5. Persist run + agent state in SQLite (schema v6).

## Data flow

```
┌─────────────── Browser ───────────────────┐
│  Conversation (SSE) · Files · Overview     │
│  message box → steer / followUp            │
└──────────────────┬─────────────────────────┘
                   │ GET /messages (durable) + GET /stream (SSE)
                   │ POST /message
┌──────────────────▼─────────────────────────┐
│         AegisX server (Hono / Bun)          │
│                                            │
│  ┌─ Run AgentSession (main, per run) ──────┐ │
│  │  tools: read/bash/edit/write/grep/find/ls │
│  │         submit_flag / target_* / finish   │
│  │         spawn_agent (child session)       │
│  │  session.subscribe → events.ts →          │
│  │     session_entries (committed) + SSE (live)   │
│  └───────────────┬──────────────────────────┘ │
│                  │ docker exec (bash)         │
│                  │ host fs (file tools)       │
┌──────────────────▼──────────────────────────┐
│   Docker container (solver image)            │
│   main process: sleep infinity (tool box)     │
│   /workspace ← bind (shared with host)        │
│   Kali toolchain: python/pwntools/gdb/...     │
└──────────────────────────────────────────────┘
```

## Layout

```
apps/server/src/
  app.ts            composition root; recoverOnBoot; route registration
  index.ts          Bun.serve entry (idleTimeout 0 for quiet SSE)
  run/
    service.ts        lifecycle state machine + facade (create/send/stop/close/finish/delete/recover)
    provision.ts      main-agent assembly shared by create + ensureWarm (dedup)
    child-agents.ts   background child-agent orchestration (spawn_agent)
    queries.ts        run/agent reads; durable messages from session_entries
    routes.ts         /api/runs/** + /messages + /stream + /message
    tools.ts          native tools: submit_flag/target_*/finish_run/spawn_agent
    model-runtime.ts  ProviderConnection → pi ModelRuntime + Model (models.json)
    prompt.ts         handlebars PromptTemplateContext + attachment copy
    public.ts         RunPublic + AgentSummary projections
    errors.ts         RunActionError / RunStartError
    session/          pi-facing layer
      agent-session.ts    createAgentSession wrapper + pipeline wiring
      db-session-manager.ts DB-backed SessionManager drop-in (single source of truth)
      events.ts           SDK AgentSessionEvent → committed entry + live progress
      live.ts             in-memory SSE fan-out bus
      entry-usage.ts      token/cost accumulator (pi-TUI footer parity)
    container/        docker layer
      container-manager.ts dockerode lifecycle + exec() (no PTY)
      container-tools.ts   BashOperations → docker exec
    workspace/        host-fs file tools (bind-shared with the container)
      backend.ts · tools.ts · edit-apply.ts · tool-prompts.ts · tar-stream.d.ts
  platforms/        adapters (ctfd/ret2shell/a1ctf) + sync/submit/targets
  providers/        model registry + pi models.json generation
  settings/         prompt templates + settings routes
  events/           event/challenge/attachment routes + catalog
  db/               drizzle schema v6 + compat guard + migrations
apps/shared/        wire types (Run/Agent/Message/LiveEvent/Settings/...)
apps/web/           React + Vite; Conversation timeline; coss UI
containers/solver/  Kali-based solver image (sleep infinity CMD)
```

## Run lifecycle (v5)

A run is a **long-lived pi session + container**; the lifecycle revolves around
the SDK's `isStreaming`, not around per-turn teardown. There is no `resume`
concept: messaging a run always works. See
[lifecycle-redesign.md](./lifecycle-redesign.md) for the full rationale.

Statuses: `running` (turn in flight, container warm) · `idle` (between turns,
container warm) · `closed` (container + in-process session released; the DB
session is retained, cold-restorable by messaging). `finish_run` releases the container
(`closed`) but is **not** a dead terminal — the run can be re-opened.

- **create** (`service.create`): copy attachments into the workspace, render the
  prompts, build an isolated `ModelRuntime` (per-run `models.json`), start the
  tool-box container, build the native tools, `createAgentSession`, insert the
  run as `running`, then `driveRun(initial)`.
- **driveRun → settleTurn**: `prompt()` resolves on natural idle, after
  `finish_run` (tool returns `terminate`), or after an abort. `settleTurn` is the
  single settle point; a generation guard makes a stale turn (superseded by a
  newer one) no-op. finish/close → `freeRun` (release container + session →
  `closed`, keeping the DB session); otherwise → `idle` (container kept).
- **sendMessage** (POST `/message`): streaming → `steer`/`followUp`; idle →
  `prompt`; closed → `ensureWarm` (cold-restore: new container +
  `DbSessionManager.open` + `createAgentSession`) then `prompt`.
- **stop** (Esc): `session.abort()`; the turn settles to `idle` (container kept).
- **finish** (tool or POST `/finish`): pending finish + abort → `freeRun` →
  `closed` + summary (`completedAt`).
- **close** (POST `/close`): manually release a warm run's container → `closed`.
- **delete**: remove the container (if warm), dispose the session, delete the
  DB session + workspace + row.
- **recoverOnBoot**: on startup, any `running`/`idle` row is marked `closed`
  (host-side session gone after a crash) and its orphan container reclaimed.
- **compaction / retry**: handled by the SDK via `SettingsManager.inMemory`,
  configurable in the settings UI.

## Visibility & data flow

```
session.subscribe(event)
  → events.ts normalizes SDK events
  → committed entries (DbSessionManager.onAppend) → SQLite session_entries
  → live progress (text_delta / tool_execution_* / compaction / retry) → SSE bus
```

`GET /api/runs/:id/messages?after=&agentId=` returns durable committed entries
(from `session_entries`, ordered by `seq`). `GET /api/runs/:id/stream`
is the ephemeral SSE channel. The frontend `ConversationStore` merges committed
history with live progress, splitting at the last user message so only the
active turn rebuilds on streaming.

## Native tools

| Tool | Purpose | Registered when |
|------|---------|-----------------|
| `bash` | run inside the Kali container (`docker exec`) | always (overrides builtin) |
| `read`/`edit`/`write`/`grep`/`find`/`ls` | host workspace (bind-shared) | always |
| `submit_flag` | `platformService.submitFlag` (in-process) | platform integrated |
| `target_get`/`start`/`extend`/`stop` | `platformService.targetAction` | challenge has a target |
| `finish_run` | summary → finalize → `completed` | main only |
| `spawn_agent` | child `AgentSession` (coding tools only) | main only |

Child agents share the workspace and model but cannot finish, submit, manage
targets, or spawn further agents. Concurrent children per run are capped.

## Data model (schema v6)

`events` → `event_platforms` → `challenges` → (`attachments`, `challenge_remote`)
→ `runs` → (`agents`, `sessions` → `session_entries`, `submissions`). Plus
`platform_request_log`. Older databases are refused at open (full wipe);
`SCHEMA_VERSION = 6`.

`runs` dropped the v3 `launcher`/`pi_model_ref` and gained `session_dir`.
`agents` (main + child), `sessions` + `session_entries` (committed
SessionEntry log — one row per pi entry, byte-for-byte the jsonl line,
monotonic `seq` per session) are new.

## API (run)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/challenges/:id/runs` | create (model/image/thinking optional) |
| GET | `/api/runs/:id` | `{ run, agents }` |
| GET | `/api/runs/:id/messages?after=&agentId=` | committed messages (paginated) |
| GET | `/api/runs/:id/stream` | live SSE (EventSource) |
| POST | `/api/runs/:id/message` | `{ text, deliverAs?: "steer"\|"followUp" }` |
| GET | `/api/runs/:id/files` `[?path=]` | workspace listing/preview |
| GET | `/api/runs/:id/files/download` | workspace file download |
| POST | `/api/runs/:id/stop \| /close \| /finish` | control |
| POST | `/api/runs/:id/flag` | platform flag submission |
| GET/POST | `/api/runs/:id/target[/:action]` | target inspect/start/extend/stop |
| DELETE | `/api/runs/:id` | any run (frees container if warm) |

The v3 `GET /api/runs/:id/pty` WebSocket is gone.

## Settings

Unchanged surface (`apps/shared/settings-schema.ts`): agent defaults, runtime
timeouts, container resources, and the three prompt templates (now referencing
native tool names). compaction/retry are wired to the SDK via
`SettingsManager.inMemory` and configurable in the settings UI.

## Known limitations / deferred

- No Orchestrator (multi-run scheduling) — explicitly out of v4 scope.
- `bash` is one `docker exec` per call (no long-lived shell reuse yet).
- Per-run timeout: no `timed_out` status in v5 (lifecycle collapsed to running/idle/closed); a future timeout would abort the turn → `idle`.
