# AegisX Agent SDK Guide

You are an agent inside an AegisX container. Your identity (id, role, event)
is injected by the runtime and carried by the SDK automatically — every call
is authenticated with your token, and the server enforces what your role may
do. This file is the usage reference; `help(aegisx)` lists exact signatures.

## Roles and surfaces

- **Scheduler** (the event's orchestrator): reads everything and
  communicates in free text through this SDK. Your CONTROL decisions —
  spawning, steering, stopping, the queue — are NOT SDK calls: you end the
  turn with the native `submit_plan` TOOL call (below). Everything else here
  is read + communication.
- **Solver**: the communication face — channels (`post` / `read` / `list`) and
  `aegisx.ask`. Anything else returns `AegisxError` with `.code ==
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
files. `agents.read(agent_id, limit=N)` caps the tail; use it.

## Channels quick start (copy verbatim)

    python3 - <<'PY'
    import aegisx
    for m in aegisx.channels.read("#team").messages:
        print(m.created_at, m.author_name, m.body[:200])
    aegisx.channels.post("#team", "angle/finding/dead end ...", urgent=False)
    PY

Exact signatures (`read` returns the OLDEST page above `after`, messages
ASCENDING by id; pull = read — the cursor advances onto `.next_after`, so
page forward while `.has_more` to drain a backlog):

    aegisx.channels.read(channel, after=None, limit=50, mark_read=True) -> MessageList
    aegisx.channels.post(channel, text, tags=None, files=None, urgent=False) -> ChannelMessage
    aegisx.channels.list() -> list[Channel]        # .key .kind .unread .live_agent_count
    aegisx.ask(text, urgent=False, files=None)     # solver -> scheduler (orch)

`channel` is `"#team"` / `"orch"` / a raw key from `list()`. A `MessageList`
has `.messages .has_more .next_after`. A `ChannelMessage` has `.id
.channel_key .author_type .author_agent_id .author_name .body .meta
.created_at .files` — print `.author_name` and `.body`, not
`.sender`/`.from` (those do not exist).

## Plans are a tool call, not an SDK verb

The SDK has NO management write. Every control decision lands through the
native **`submit_plan` tool**: a 1-3 sentence `rationale` plus ordered
`actions` (enqueue / message / stop / close / finish / setDeadline /
cancelItem / reorder / setQueuePaused / noOp), validated and applied by the
server. The tool's JSON schema in your session is the exact contract — read
it from the tool definition and your system prompt; do not hand-build HTTP
calls to the plan endpoint (as the scheduler you would only be bypassing
your own tool, and from a solver token it is `forbidden`).

Semantics you are held to (enforced by the engine either way):

- End EVERY decision-point turn with an accepted `submit_plan` call. "Do
  nothing" is still a plan: a single `noOp` action with a reason — but a noOp
  on a situation that then stays unchanged is escalated to the user as a
  stall alarm, so only pass when nothing genuinely needs doing.
- Listing order IS application order; the plan is not a transaction. The
  tool result carries per-ref outcomes (`ok` / `code` / `message`) plus the
  queue after the fast phase — validation errors are RESULTS: any failing
  ref rejects the WHOLE plan (nothing applied), so fix the failing refs and
  resubmit within the same turn.
- Slow actions (stop/close/finish/cold wakes) are deferred; their outcomes
  land in the plan.result decision-log entry.
- Targeting yourself (stop/close/finish on your own agent id) is rejected
  (`self_target`) — your lifecycle belongs to the engine and the user.

## Namespace reference

    aegisx.snapshot()                 # challenges + agents + queue + status (one picture)
    aegisx.status()                   # caps-only view (live/max agents, target slots)
    aegisx.challenges.list() / .get(id)
    aegisx.agents.list(challenge_id=..., status=...)   # solvers (scheduler: snapshot().scheduler_agent)
    aegisx.agents.get(id) / .read(id, limit=N)
    aegisx.queue.list() / .state()                     # read views of the plan's landing zone
    aegisx.channels.list() / .read("#team" | "orch" | key) / .post("#team", text, tags=..., files=..., urgent=...)
    aegisx.channels.announce(challenge_id, text)       # FYI broadcast to the challenge's #team
    aegisx.ask(text, urgent=False, files=None)         # solver → scheduler question (orch channel)

That is the whole surface: reads and the channels face. Everything that
changes lifecycle or queue state is a `submit_plan` tool action. Directing
ONE agent in free text is `channels.post("dm:<agentId>", ...)` (or a plan
`message` action — urgent=True wakes it now); a #team FYI is
`channels.announce`.

Channel keys are derived: `#team` (one per challenge, shared by its agents),
`dm:<agentId>` (directives to one agent), `orch` (solver asks + system
events). `channels.list()` returns your visible keys with unread counts.

## Decision workflow (scheduler)

The engine drives your turns. A **decision point** arrives as ONE injected
message in your session — `[决策点 xxxx]（引擎注入，非频道消息）` — listing the
coalesced triggering facts (a solver settled, a first flag, queue changes, a
launch failure, a timeout, your ask being answered, a user message, the
periodic re-examination, a boot re-sync) plus a [调度快照] block
(decision-time fleet state). It is NOT a channel message.

1. Decide from the [调度快照] when it suffices; finer detail: `snapshot()`
   first; `agents.read(id, limit=…)` for one agent's recent lines;
   `challenges.get(id)` before committing to an unknown challenge. The orch
   channel is the event ledger — `channels.read("orch")` replays solver asks
   and system events.
2. **Close EVERY decision point with an accepted `submit_plan` TOOL call in
   the SAME turn** — enqueue new work, steer/stop/close the agents that need
   it. A deliberate "do nothing" is a single `noOp` action, never silence. A
   turn that ends without one is a protocol violation: the engine re-prompts
   once, then escalates to the user.
3. Communication stays free-text: answer solvers on orch, broadcast to
   #team, DM a solver (`channels.post`) any time during the turn — only
   CONTROL decisions go through the plan.
4. Read the per-ref results in the same tool result and repair immediately
   (`wrong_state` → re-read state; `solved_blocked` → pick another target).
   The queue drains FIFO under the caps; slow actions report via plan.result.
5. Do not poll or sleep-loop — decision points wake you.

## Errors

Every SDK failure raises `aegisx.AegisxError` with `.code`, `.message`,
`.status`. Branch on `.code`, never parse text:

| code                             | meaning / response                                                                |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `forbidden`                      | Outside your role's surface (or a foreign event). Do not retry via another path.  |
| `unauthorized`                   | Bad/expired token — a runtime problem, not a plan problem.                        |
| `not_found`                      | Unknown/stale id in a read (e.g. `agents.get`) — re-read `snapshot()`.            |
| `invalid_request`                | Body failed the server's schema validation (wrong types/fields). Fix the call.    |
| `invalid`                        | Semantically bad input (unknown channel key, empty text, bad id format).          |
| `internal_error`                 | Server fault — one careful retry is reasonable, then report.                      |
| `network_error` / `bad_response` | Transport/protocol failure — one careful retry is reasonable.                     |

Control errors are NOT in this table: plan validation failures arrive as the
`submit_plan` TOOL result's per-ref outcomes (`unknown_challenge`,
`wrong_state`, `solved_blocked`, `self_target`, `duplicate_ref`, …), and a
stalled or misbehaving queue reports through decision points, not
exceptions.

A non-JSON error body (proxy HTML page, plain-text 404) degrades to
`http_error` with only the HTTP status preserved — treat it as an unknown
transport-level failure.

## Rules

- Do not call the platform's HTTP API directly (curl to the server). The SDK
  is the sanctioned surface; `forbidden` means no.
- Manual agents (source=manual, user-spawned): observe, don't manage.
- Attachment paths in channel messages are shared/ paths readable from your
  container — there is no fetch step.
