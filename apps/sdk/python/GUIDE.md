# AegisX Agent SDK Guide

You are an agent inside an AegisX container. Your identity (id, role, event)
is injected by the runtime and carried by the SDK automatically — every call
is authenticated with your token, and the server enforces what your role may
do. This file is the usage reference; `help(aegisx)` lists exact signatures.

## Roles and surfaces

- **Scheduler** (the event's orchestrator): the management face — challenges,
  agents, the spawn queue, broadcasts. Everything below.
- **Solver**: the communication face — channels (`post` / `read` / `list`) and
  `aegisx.ask`. Management calls return `AegisxError` with `.code ==
"forbidden"`; that answer is authoritative — never fall back to curl or the
  platform's HTTP API.

## Running scripts

One composite operation per script, via bash heredoc (`python3 - <<'PY'` …
`PY`). There is no REPL session; persist reusable helpers in
`scheduler_lib.py` in your working directory and `import scheduler_lib`.

    import aegisx
    snap = aegisx.snapshot()
    for c in snap.challenges:
        if not c.solved_now and c.points:
            print(c.id, c.points, c.name, c.agent_status_counts)

Output budget: bash truncates at ~64KB — print summaries, write bulk data to
files. `agents.read(agent_id, last_n=N)` caps the tail; use it.

## Namespace reference

    aegisx.snapshot()                 # challenges + agents + queue + status (one picture)
    aegisx.status()                   # caps-only view (live/max agents, target slots)
    aegisx.challenges.list() / .get(id)
    aegisx.queue.list() / .state() / .enqueue(challenge_id, prompt=..., model=..., timeout_ms=...)
    aegisx.queue.pause() / .resume() / .remove(id) / .clear() / .reorder(ids)
    aegisx.agents.list(challenge_id=..., status=...)   # solvers only (scheduler: snapshot().scheduler_agent)
    aegisx.agents.get(id) / .read(id, last_n=N)
    aegisx.agents.message(id, text, urgent=True)       # directive into the agent's DM
    aegisx.agents.start(challenge_id, prompt=...)      # ESCAPE HATCH: spawn immediately, bypasses the queue
    aegisx.agents.stop(id) / .close(id) / .finish(id, summary) / .compact(id) / .set_timeout(id, ms)
    aegisx.channels.list() / .read("#team" | "orch" | key) / .post("#team", text, tags=..., files=..., urgent=...)
    aegisx.channels.announce(challenge_id, text)       # FYI broadcast to the challenge's #team
    aegisx.ask(text, urgent=False)                     # solver → scheduler question (orch channel)

Channel keys are derived: `#team` (one per challenge, shared by its agents),
`dm:<agentId>` (directives to one agent), `orch` (solver asks + system
events). `channels.list()` returns your visible keys with unread counts.

## Decision workflow (scheduler)

1. Every delivery ends with a [调度快照] block (delivery-time fleet state).
   Decide from it when it suffices.
2. Finer detail: `snapshot()` first; `agents.read(id, last_n=…)` for one
   agent's recent lines; `challenges.get(id)` before committing to an
   unknown challenge.
3. Plan = the queue: `queue.enqueue(challenge_id, prompt=...)` per task; the
   system drains FIFO under the caps. `agents.start` only for deliberate
   immediate spawns.
4. Steer with `agents.message`; stop a stuck turn with `agents.stop`; free
   the cap with `agents.close`; record a delivered result with
   `agents.finish(id, summary)`.
5. Do not poll or sleep-loop — events wake you.

## Errors

Every failure raises `aegisx.AegisxError` with `.code`, `.message`,
`.status`. Branch on `.code`, never parse text:

| code                             | meaning / response                                                                |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `forbidden`                      | Outside your role's surface (or a foreign event). Do not retry via another path.  |
| `unauthorized`                   | Bad/expired token — a runtime problem, not a plan problem.                        |
| `capacity`                       | Concurrency cap full (spawn/enqueue). Adjust the plan; queued work stays pending. |
| `not_found`                      | Stale id — re-read state (`snapshot()`).                                          |
| `invalid_state`                  | e.g. compaction without a live session, close on a closed agent.                  |
| `network_error` / `bad_response` | Transport/protocol failure — one careful retry is reasonable.                     |

## Rules

- Do not call the platform's HTTP API directly (curl to the server). The SDK
  is the sanctioned surface; `forbidden` means no.
- Manual agents (source=manual, user-spawned): observe, don't manage.
- Attachment paths in channel messages are shared/ paths readable from your
  container — there is no fetch step.
