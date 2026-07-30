> **ARCHIVED.** Describes the deleted v2 multi-agent model. The current architecture is [../architecture.md](../architecture.md).

# Multi-agent orchestration (v2)

Authoritative design: [architecture-v2.md](./architecture-v2.md).  
Implementation: `apps/server/src/run/` and `apps/server/src/agent/`.

## Run model

- A run has exactly one main agent and zero or more child agents.
- Run id and main agent id are **distinct**.
- Only the main agent can create children or complete the run.
- Child agents cannot create more agents.
- User messages are delivered only to the main agent.
- All agents in a run use the run's model, credentials, and execution environment.
- `maxConcurrency` counts active agents (`running` ∪ `idle`), not runs.

The main agent can call `spawn_agent` / `inspect_agent`. Completed child output
is written as a `notice` message on the main agent and dispatched live.

## Lifecycle

- A main agent that finishes a turn without `finish_run` becomes `idle`; the run stays `running`.
- A child that finishes becomes `completed` or `failed` and does **not** fail the run.
- Pause / resume / stop apply to every non-terminal agent in the run.
- Resume requires concurrency capacity for all paused agents.
- On API startup, interrupted `running` runs become `paused` (or complete if a valid pending finish exists). No model call is made automatically.
- Only `finish_run(summary)` (after the main turn settles) completes a run.

## Persistence

- SQLite stores runs, agents, ordered `messages`, and `agent_usage`.
- There is **no** durable SSE event log and **no** `agent_inbox`.
- Wire message shape is the persisted `Message` type (`apps/shared/message.ts`).

## Live events

Clients should:

1. `GET /api/runs/:id` — run + agents + usage  
2. `GET /api/runs/:id/messages?agentId=&after=` — committed messages  
3. `GET /api/runs/:id/stream` — live-only SSE  

Reconnect by re-fetching messages and opening a new stream.

## Workspaces

Every agent in a run uses the same workspace root. Local execution inherits API
process permissions; container execution uses the run's shared restricted container.

## Challenge targets

- AegisX does not start a remote target when a run begins.
- Target tools are main-agent only.
- Runs do not auto-stop targets on completion; the main agent must stop them before `finish_run` when required.
