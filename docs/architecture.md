# AegisX Architecture

Status: **current** (v3)
Related: [refactor-v3.md](./refactor-v3.md) is the historical v2→v3 transition plan.

## What v3 is

A run is **one Docker container whose main process is `pi`** (the interactive
coding-agent TUI). The browser renders that TTY live (ghostty-web) and can type
into it to steer the agent mid-run. There is no in-process agent loop, no SSE
message timeline, no multi-agent table — a run is `1 run = 1 container = 1 pi`.

Server responsibilities are intentionally narrow:

1. Orchestrate container lifecycle (create/start/wait/kill/resize/reattach).
2. Generate the per-run pi-agent volume (`models.json`, `APPEND_SYSTEM.md`,
   `CHILD_SYSTEM.md`, `settings.json`, skills).
3. Expose the run-level HTTP API the agent calls back over (`/flag`, `/finish`,
   `/target`, `/files`, `/pty`).
4. Bridge the container PTY to N browser WebSocket connections (ring-buffer
   replay, resize control).
5. Persist run state + pi session identity in SQLite (the source of truth).

## Data flow

```
┌─────────────── Browser ───────────────┐
│  ghostty-web  ⇄  WS (/api/runs/:id/pty)│   binary frames = stdin/stdout bytes;
└───────────────┬────────────────────────┘   text frame = {resize|ping} control
┌───────────────▼────────────────────────┐
│        AegisX server (Hono / Bun)       │
│  run-service · container-manager        │
│  pty-bridge · models-json/skills gens   │
│  platform service · run HTTP API        │
└───────────────┬────────────────────────┘
                │ dockerode: create/start/wait/kill/resize; raw-socket PTY attach
┌───────────────▼────────────────────────┐
│   Docker container (solver image)       │
│   main process: pi (interactive TUI)     │
│   /workspace       ← run workspace vol   │
│   /root/.pi/agent  ← pi-agent vol        │
│     models.json · APPEND_SYSTEM.md       │
│     CHILD_SYSTEM.md · settings.json      │
│     skills/{aegisx,aegisx-target,...}    │
│   env: AEGISX_API_URL/RUN_ID/CHALLENGE_* │
│        AEGISX_PI_MODEL                   │
└──────────────────────────────────────────┘
```

The agent talks back to AegisX over `AEGISX_API_URL=http://host.docker.internal:<port>`
(`host.docker.internal:host-gateway` is added to the container). Skills are pure
documentation that teach the agent the `curl` commands for the run HTTP API.

## Layout

```
apps/server/src/
  app.ts            composition root; recoverOnBoot; run hooks
  index.ts          Bun.serve entry (port = PORT ?? 3000)
  run/
    service.ts        lifecycle: create/stop/finish/resume/delete/recover/close
    routes.ts         /api/runs/** + /api/challenges/:id/runs + PTY WS
    container-manager.ts  dockerode lifecycle + raw-socket PTY hijack (Bun-safe)
    pty-bridge.ts     ring buffer + multi-connection PTY fan-out
    pi-launch.ts      buildPiCmd · buildContainerEnv · generatePiAgentVolume
    prompt.ts         handlebars PromptTemplateContext + attachment copy
    queries.ts        run reads
  platforms/        adapters (ctfd/ret2shell/a1ctf) + sync/submit/targets
  providers/        model registry + pi models.json generation
  settings/         prompt templates + settings routes
  events/           event/challenge/attachment routes + catalog
  db/               drizzle schema v3 + compat guard + migrations
  infrastructure/   config-store · storage · workspace-files · http-errors
apps/shared/        wire types (Run/Challenge/Event/Platform/Settings/...)
apps/web/           React + Vite; ghostty-web terminal; coss UI
containers/solver/  Kali-based solver image (pi runs here)
```

## Run lifecycle

- **create** (`service.create`): copy attachments into the workspace, render the
  main + child + initial prompts, generate the pi-agent volume, `INSERT runs`,
  `containerManager.launch` (create+start+attach), `attachBridge`, `watchExit`,
  then poll for the pi session id (`discoverSessionLater`).
- **watchExit → finalize**: when pi exits, the run is finalized under a per-run
  lock. Outcome priority: explicit `finish`/`stop` > exit code 0 (`completed`) >
  non-zero (`failed`).
- **stop / finish**: set a pending outcome, send `SIGTERM`; if pi does not exit
  within a grace window, escalate to `SIGKILL` (see `terminateContainer`).
- **resume**: a new container re-runs `pi --session <id>` against the same
  pi-agent volume so it continues the same conversation.
- **recoverOnBoot**: on startup, `running` rows whose container is still up are
  reattached; others are marked `stopped`. No model call is made automatically.

## Agent integration (skills)

Generated into `/root/.pi/agent/skills/` per run:

| Skill | When | Purpose |
|-------|------|---------|
| `aegisx` | always | submit a flag + finish the run (curl `/flag`, `/finish`) |
| `aegisx-target` | challenge has a remote target | inspect/start/extend/stop the target |
| `aegisx-child` | always | delegate a bounded sub-task to a child `pi` process |

The main agent runs interactively with `read,bash,edit,write,grep,find,ls`.
Submitting flags, finishing, target control, and delegation are **not** built-in
tools — they are skills the agent loads and calls via curl / bash. The child
agent is launched by the main agent over bash (`pi -p --no-skills
--system-prompt "$(cat …/CHILD_SYSTEM.md)" …`); it shares the workspace and
credentials but cannot finish/submit/manage targets/spawn.

## Data model (schema v3)

`events` → `event_platforms` (one platform binding per event) → `challenges` →
(`attachments`, `challenge_remote`) → `runs` → `submissions`. Plus
`platform_request_log` for adapter diagnostics. v1/v2 databases are refused at
open (see `db/index.ts` `assertCompatibleSchema`); v3 is a full data wipe.

## Settings

Only settings that are actually read by the runtime are exposed
(`apps/shared/settings-schema.ts`):

- `agent.defaultModelId`, `agent.defaultThinkingLevel`
- `runtime.maxAttachmentMb`, `runtime.platformRequestTimeoutMs`,
  `runtime.providerDiscoverTimeoutMs`
- `container.image/cpus/memoryMb/pidsLimit/workspace/tmpfsSize`
- `prompts.mainSystem`, `prompts.childSystem`, `prompts.initial`

Earlier "local mode", concurrency, retry, tool-output, and per-tool-timeout
settings belonged to the deleted v2 in-process agent loop and have been removed.

## API (run)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/challenges/:id/runs` | create (model/image/thinking optional) |
| GET | `/api/runs/:id` | `{ run }` |
| GET | `/api/runs/:id/files` | workspace listing/preview (`?path=`) |
| GET | `/api/runs/:id/files/download` | workspace file download |
| GET | `/api/runs/:id/pty` | live PTY over WebSocket |
| POST | `/api/runs/:id/message` | (reserved) |
| POST | `/api/runs/:id/stop \| /resume \| /finish` | control |
| POST | `/api/runs/:id/flag` | platform flag submission |
| GET/POST | `/api/runs/:id/target[/:action]` | target inspect/start/extend/stop |
| DELETE | `/api/runs/:id` | terminal runs only |

## Known limitations

- PTY streaming is live-only; reconnect replays the ring buffer, not a durable
  event log.
- Token/cost usage stats are not parsed from the pi session in this iteration.
- Local (non-container) execution is not supported; v3 is Docker-only.
