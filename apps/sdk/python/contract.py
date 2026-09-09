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
SOLVER2_ID = ARGS["solver2-id"]

aegisx.configure(api_url=BASE_URL, event_id=EVENT_ID)


def become(token: str, agent_id: str) -> None:
    os.environ["AEGISX_TOKEN"] = token
    os.environ["AEGISX_AGENT_ID"] = agent_id


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

aegisx.agents.message(SOLVER_ID, "contract directive")
ok("agents message (dm directive)")

stopped = aegisx.agents.stop(SOLVER_ID)
assert stopped.id == SOLVER_ID and stopped.status == "idle"
ok("agents stop")

# Queue lifecycle on a paused queue: enqueue stays pending (no real spawn).
assert aegisx.queue.state() == "running"
aegisx.queue.pause()
assert aegisx.queue.state() == "paused"
item = aegisx.queue.enqueue(CHALLENGE_ID, prompt="contract probe")
assert item.status == "pending", f"paused queue launched: {item.status}"
listed = aegisx.queue.list()
assert any(i.id == item.id for i in listed)
aegisx.queue.reorder([item.id])
aegisx.queue.remove(item.id)
assert not any(i.id == item.id for i in aegisx.queue.list())
doomed = aegisx.queue.enqueue(CHALLENGE_ID, prompt="contract clear probe")
aegisx.queue.clear()
assert not any(i.id == doomed.id for i in aegisx.queue.list())
aegisx.queue.resume()
assert aegisx.queue.state() == "running"
ok("queue pause/enqueue/reorder/remove/clear/resume")

after_timeout = aegisx.agents.set_timeout(SOLVER_ID, 3_600_000)
assert after_timeout.id == SOLVER_ID
ok("agents set_timeout")

finished = aegisx.agents.finish(SOLVER_ID, summary="contract finish")
assert finished.status == "completed"
ok("agents finish (sanctioned terminal)")

expect_error(
    "invalid_state", 409, lambda: aegisx.agents.compact(SOLVER_ID),
    "agents compact error contract (no live session)",
)
expect_error(
    "not_found", 404, lambda: aegisx.agents.get("no-such-agent"),
    "agents get error contract (not_found)",
)

closed = aegisx.agents.close(SOLVER2_ID)
assert closed.id == SOLVER2_ID and closed.status == "aborted"
ok("agents close (terminal aborted)")

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
    "forbidden", 403, lambda: aegisx.queue.pause(), "solver forbidden: queue.pause"
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
