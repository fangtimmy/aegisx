# AegisX Agent SDK Guide

You are an agent inside an AegisX container. Your identity (id, role, event)
is injected by the runtime and carried by the SDK automatically — every call
is authenticated with your token, and the server enforces what your role may
do. This file is the usage reference; `help(aegisx)` lists exact signatures.

## Roles and surfaces

- **Scheduler** (the event's orchestrator): reads everything, communicates in
  free text, and lands every CONTROL decision — spawning, steering, stopping,
  the queue — through ONE typed verb, `submit_plan`. Everything below.
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

## Submitting plans (the control surface)

Every management write goes through ONE verb — `submit_plan`. You produce a
typed plan (rationale + ordered actions); the server validates it, applies
the fast actions inline and defers the slow ones. Build actions with the
helpers, never hand-built JSON:

    python3 - <<'PY'
    import aegisx
    res = aegisx.submit_plan(
        "web-01 收官，预算转向 web-02",
        [
            aegisx.close("agent-a3f1"),                     # free the slot
            aegisx.enqueue("ch-web02", prompt="pwn it"),    # refill via queue
        ],
    )
    for r in res.results:
        print(r.ref, r.kind, "ok" if r.ok else f"{r.code}: {r.message}")
    print("deferred:", [(d.ref, d.kind) for d in res.deferred])
    PY

Exact signatures:

    aegisx.submit_plan(rationale, actions) -> SubmitPlanResult
    aegisx.enqueue(challenge_id, prompt=None, model=None, timeout_ms=None, ref=None)
    aegisx.message(agent_id, text, urgent=False, ref=None)
    aegisx.stop(agent_id, ref=None) / aegisx.close(agent_id, ref=None)
    aegisx.finish(agent_id, summary, ref=None)
    aegisx.set_deadline(agent_id, timeout_ms, ref=None)
    aegisx.cancel_item(item_id, ref=None) / aegisx.reorder(item_ids, ref=None)
    aegisx.set_queue_paused(paused, ref=None)
    aegisx.no_op(reason, ref=None)

Semantics:

- `rationale` is the 1-3 sentence decision reason (decision log only, never
  executed). "Do nothing" is still a plan: `[aegisx.no_op("reason")]` — but a
  noOp on a situation that then stays unchanged is escalated to the user as a
  stall alarm, so only pass when nothing genuinely needs doing.
- Listing order IS application order; the plan is not a transaction — per-ref
  results + the next snapshot are the recovery model.
- `submit_plan` returns per-ref results (`r.ok` / `r.code` / `r.message`) —
  validation errors are RESULTS, not exceptions: any failing ref rejects the
  WHOLE plan (nothing applied), so fix the failing refs and resubmit. Only a
  malformed envelope (HTTP 400) and auth errors raise `AegisxError`.
- `res.queue_after` is the queue after the fast phase; `res.deferred` lists
  the slow actions (stop/close/finish/cold wakes) whose outcomes land in the
  plan.result decision-log entry.
- Refs: helpers leave `ref` unset and `submit_plan` derives it from the
  action's content — re-running the same script after a timeout replays the
  SAME refs, so the server dedupes: identical action → original result (no
  double-enqueue), same ref with different content → `duplicate_ref`. Pass
  `ref=` explicitly to control correlation yourself.
- Targeting yourself (stop/close/finish on your own agent id) is rejected
  (`self_target`) — your lifecycle belongs to the engine and the user.

## Namespace reference

    aegisx.snapshot()                 # challenges + agents + queue + status (one picture)
    aegisx.status()                   # caps-only view (live/max agents, target slots)
    aegisx.challenges.list() / .get(id)
    aegisx.agents.list(challenge_id=..., status=...)   # solvers (scheduler: snapshot().scheduler_agent)
    aegisx.agents.get(id) / .read(id, limit=N)
    aegisx.queue.list() / .state()                     # read views of the plan's landing zone
    aegisx.submit_plan(rationale, actions)             # THE control write (see above)
    aegisx.channels.list() / .read("#team" | "orch" | key) / .post("#team", text, tags=..., files=..., urgent=...)
    aegisx.channels.announce(challenge_id, text)       # FYI broadcast to the challenge's #team
    aegisx.ask(text, urgent=False, files=None)         # solver → scheduler question (orch channel)

That is the whole surface: reads and the channels face are open to the
scheduler; everything that changes lifecycle or queue state is a plan action.
Directing ONE agent in free text is `channels.post("dm:<agentId>", ...)` (or
a plan `message` action — urgent=True wakes it now); a #team FYI is
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
2. **Close EVERY decision point with one typed plan in the SAME turn:**
   `submit_plan(rationale, [...])` — enqueue new work, steer/stop/close the
   agents that need it. A deliberate "do nothing" is `aegisx.no_op("reason")`,
   never silence. A turn that ends without a plan is a protocol violation:
   the engine re-prompts once, then escalates to the user.
3. Communication stays free-text: answer solvers on orch, broadcast to
   #team, DM a solver (`channels.post`) any time during the turn — only
   CONTROL decisions go through the plan.
4. Read the per-ref results in the same call and repair immediately
   (`wrong_state` → re-read state; `solved_blocked` → pick another target).
   The queue drains FIFO under the caps; slow actions report via plan.result.
5. Do not poll or sleep-loop — decision points wake you.

## Errors

Every failure raises `aegisx.AegisxError` with `.code`, `.message`,
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

Control errors are NOT in this table: plan validation failures are per-ref
results on `submit_plan`'s return value (`unknown_challenge`, `wrong_state`,
`solved_blocked`, `self_target`, `duplicate_ref`, …), and a stalled or
misbehaving queue reports through decision points, not exceptions.

A non-JSON error body (proxy HTML page, plain-text 404) degrades to
`http_error` with only the HTTP status preserved — treat it as an unknown
transport-level failure.

## Rules

- Do not call the platform's HTTP API directly (curl to the server). The SDK
  is the sanctioned surface; `forbidden` means no.
- Manual agents (source=manual, user-spawned): observe, don't manage.
- Attachment paths in channel messages are shared/ paths readable from your
  container — there is no fetch step.
