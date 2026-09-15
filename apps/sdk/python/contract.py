"""SDK ↔ server contract test (docs/sdk-refactor.md W5).

Launched by `bun run test:sdk` against a real server with seeded fixtures;
asserts the full SDK surface, the permission matrix (scheduler / solver /
tokenless / bad token), and the error contract. Exit 0 = pass.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import aegisx
from aegisx import AegisxError

ARGS = {}
for arg in sys.argv[1:]:
    key, _, value = arg.lstrip("-").partition("=")
    ARGS[key] = value

BASE_URL = ARGS["base-url"]
EVENT_ID = ARGS["event-id"]
CHALLENGE_ID = ARGS["challenge-id"]
SCHEDULER_TOKEN = ARGS["scheduler-token"]
SCHEDULER_ID = ARGS["scheduler-id"]
SOLVER_TOKEN = ARGS["solver-token"]
SOLVER_ID = ARGS["solver-id"]

aegisx.configure(api_url=BASE_URL, event_id=EVENT_ID)

# The management verbs were cut (control-plane §3.3/§3.8) and plan submission
# moved INTO the scheduler's turn as the native submit_plan tool (B 批): the
# SDK is reads + the channels face, nothing else.
for module, gone in [
    (aegisx.queue, ("enqueue", "edit", "pause", "resume", "remove", "clear", "reorder")),
    (
        aegisx.agents,
        ("message", "stop", "close", "finish", "compact", "set_timeout", "start"),
    ),
]:
    for name in gone:
        assert not hasattr(module, name), f"{module.__name__}.{name} must be gone"
for gone in (
    "plan",
    "submit_plan",
    "enqueue",
    "message",
    "stop",
    "close",
    "finish",
    "set_deadline",
    "cancel_item",
    "reorder",
    "set_queue_paused",
    "no_op",
    "SubmitPlanResult",
    "PlanRefResult",
    "DeferredAction",
):
    assert not hasattr(aegisx, gone), f"aegisx.{gone} must be gone"


def become(token: str, agent_id: str) -> None:
    os.environ["AEGISX_TOKEN"] = token
    os.environ["AEGISX_AGENT_ID"] = agent_id


def plan_post(body) -> dict:
    """Raw plan-endpoint access (the HTTP escape hatch the SDK deliberately
    does NOT wrap — plans go through the scheduler's native tool)."""
    return aegisx.get_client().request(
        "POST", aegisx.get_client().event_path("/plan"), body=body
    )


def ok(name: str) -> None:
    print(f"ok   {name}", flush=True)


def expect_error(code: str, status: int, fn, name: str) -> None:
    try:
        fn()
    except AegisxError as error:
        assert error.code == code, f"{name}: expected {code}, got {error}"
        assert error.status == status, f"{name}: expected HTTP {status}"
        ok(name)
        return
    raise AssertionError(f"{name}: expected AegisxError {code}, call succeeded")


# --- scheduler face ----------------------------------------------------------

become(SCHEDULER_TOKEN, SCHEDULER_ID)

snap = aegisx.snapshot()
assert snap.challenges, "snapshot: no challenges"
first = snap.challenges[0]
# The P0 regression guard: challenges must be full records (points, solved
# aggregates, agent counts), not the 3-field fleet digest.
assert first.id == CHALLENGE_ID and first.points is not None
assert isinstance(first.agent_status_counts, dict)
assert snap.scheduler_agent is not None, "snapshot: scheduler agent missing"
assert snap.status.max_concurrent_agents > 0
assert snap.queue_state in ("running", "paused")
ok("scheduler snapshot (full challenge records)")

assert aegisx.status().live_agent_count >= 1
ok("scheduler status")

chal = aegisx.challenges.get(CHALLENGE_ID)
assert chal.name and chal.points is not None
assert [c.id for c in aegisx.challenges.list()] == [CHALLENGE_ID]
ok("challenges get/list")

solvers = aegisx.agents.list(challenge_id=CHALLENGE_ID)
assert any(a.id == SOLVER_ID for a in solvers)
ok("agents list (solver-scoped)")

detail = aegisx.agents.get(SOLVER_ID)
assert detail.agent.id == SOLVER_ID
ok("agents get")

read = aegisx.agents.read(SOLVER_ID, limit=2)
# The P1 regression guard: the tail cap is honored client-side.
assert len(read.messages or []) <= 2, "agents.read: limit ignored"
ok("agents read limit tail cap")

expect_error(
    "not_found", 404, lambda: aegisx.agents.get("no-such-agent"),
    "agents get error contract (not_found)",
)

# Queue read views (the plan tool's landing zone — read side only here).
assert aegisx.queue.state() == "running"
assert isinstance(aegisx.queue.list(), list)
ok("queue read views")

# The HTTP plan endpoint stays as the raw escape hatch (scheduler identity
# admitted), while the SDK surface has no plan verb at all.
res = plan_post(
    {"rationale": "contract: deliberate pass", "actions": [{"ref": "n1", "kind": "noOp", "reason": "nothing to do"}]}
)
assert res["results"][0]["ok"] and res["results"][0]["kind"] == "noOp"
ok("plan endpoint alive for the scheduler identity (unwrapped by the SDK)")

# --- plan endpoint permission + schema (raw HTTP) -----------------------------

become(SOLVER_TOKEN, SOLVER_ID)
expect_error(
    "forbidden", 403,
    lambda: plan_post({"rationale": "x", "actions": [{"ref": "n1", "kind": "noOp", "reason": "y"}]}),
    "solver forbidden: plan endpoint",
)
become(SCHEDULER_TOKEN, SCHEDULER_ID)
expect_error(
    "invalid_request", 400,
    lambda: plan_post({"rationale": "x", "actions": [{"kind": "bogus"}]}),
    "plan endpoint malformed schema (400)",
)

team_key = f"team:{CHALLENGE_ID}"
msg = aegisx.channels.announce(CHALLENGE_ID, "contract announce")
assert msg.channel_key == team_key
seen = [m.body for m in aegisx.channels.read(team_key, mark_read=False).messages]
assert "contract announce" in seen
ok("channels announce + read (scheduler)")

orch_page = aegisx.channels.read("orch", mark_read=False)
assert isinstance(orch_page, aegisx.MessageList)
ok("channels read orch (scheduler)")

# Paging: a page is the OLDEST window above `after` and reports truncation
# (has_more + next_after) — paging forward must reconstruct the channel
# exactly (no overlap, no gap).
for i in range(3):
    aegisx.channels.post(team_key, f"contract paging {i}")
whole = [
    m.id for m in aegisx.channels.read(team_key, mark_read=False).messages
]
page1 = aegisx.channels.read(team_key, limit=2, mark_read=False)
assert len(page1.messages) == 2 and page1.has_more, "truncation not surfaced"
page2 = aegisx.channels.read(
    team_key, after=page1.next_after, limit=2, mark_read=False
)
assert [m.id for m in page2.messages] == whole[2:4], "paging skipped/overlapped"
assert page2.has_more is False
ok("channels read paging (has_more/next_after)")

# Pull = read: a mark_read pull advances the reader's cursor, so the
# unread backlog drains (the delivery layer will not re-inject consumed
# messages). Asserted on the solver face below, where the solver has a
# non-zero unread backlog authored by the scheduler.
probe = aegisx.channels.post(team_key, "contract cursor probe")
ok("channels mark_read probe posted")

# --- solver face --------------------------------------------------------------

become(SOLVER_TOKEN, SOLVER_ID)

keys = [c.key for c in aegisx.channels.list()]
assert team_key in keys and f"orch:{EVENT_ID}" in keys, f"solver channels: {keys}"
ok("solver channels list")

# Pull = read: a mark_read pull advances the reader's cursor, so the
# unread backlog drains (the delivery layer will not re-inject consumed
# messages). Measured on the solver face BEFORE its own first post — an
# author's own post also advances their cursor (channels.ts), which would
# mask the effect.
unread_before = next(c.unread for c in aegisx.channels.list() if c.key == team_key)
pulled = [m.id for m in aegisx.channels.read(team_key).messages]
assert probe.id in pulled, "posted probe missing from the pull"
unread_after = next(c.unread for c in aegisx.channels.list() if c.key == team_key)
assert unread_before > 0 and unread_after < unread_before, (
    f"cursor did not advance (pull != read): {unread_before} -> {unread_after}"
)
ok("channels mark_read advances the cursor")

posted = aegisx.channels.post("#team", "solver contract post")
assert posted.channel_key == team_key
aegisx.ask("contract ask", urgent=False)
ok("solver channels post + ask")

mine = aegisx.agents.get(SOLVER_ID)
assert mine.agent.id == SOLVER_ID
ok("solver reads own agent face")

expect_error(
    "forbidden", 403, aegisx.queue.list, "solver forbidden: queue.list"
)
expect_error(
    "forbidden", 403,
    lambda: aegisx.get_client().request(
        "POST", aegisx.get_client().event_path("/queue/pause"), body={}
    ),
    "solver forbidden: queue pause route",
)
expect_error(
    "forbidden", 403,
    lambda: aegisx.agents.get(SCHEDULER_ID), "solver forbidden: foreign agent detail",
)
expect_error(
    "forbidden", 403,
    lambda: aegisx.snapshot(), "solver forbidden: snapshot (management face)",
)

# --- tokenless (user face passes untouched) -----------------------------------

become("", "")
tokenless_snap = aegisx.snapshot()
assert tokenless_snap.challenges, "tokenless snapshot failed"
ok("tokenless user face still open")

expect_error(
    "invalid", 400,
    lambda: aegisx.channels.post("#team", "tokenless json post"),
    "tokenless JSON channel post rejected (use multipart)",
)

# --- bad token ------------------------------------------------------------------

become("deadbeef-token", "")
expect_error(
    "unauthorized", 401, aegisx.queue.list, "bad token rejected (401)"
)

print("CONTRACT PASS")
