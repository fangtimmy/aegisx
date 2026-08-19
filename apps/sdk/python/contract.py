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
assert detail.agent["id"] == SOLVER_ID
ok("agents get")

read = aegisx.agents.read(SOLVER_ID, last_n=2)
# The P1 regression guard: the tail cap is honored client-side.
assert len(read.messages or []) <= 2, "agents.read: last_n ignored"
ok("agents read last_n tail cap")

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
aegisx.queue.resume()
assert aegisx.queue.state() == "running"
ok("queue pause/enqueue/reorder/remove/resume")

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

team_key = f"team:{CHALLENGE_ID}"
msg = aegisx.channels.announce(CHALLENGE_ID, "contract announce")
assert msg.channel_key == team_key
seen = [m.body for m in aegisx.channels.read(team_key, mark_read=False)]
assert "contract announce" in seen
ok("channels announce + read (scheduler)")

orch_msgs = aegisx.channels.read("orch", mark_read=False)
assert isinstance(orch_msgs, list)
ok("channels read orch (scheduler)")

# --- solver face --------------------------------------------------------------

become(SOLVER_TOKEN, SOLVER_ID)

keys = [c.key for c in aegisx.channels.list()]
assert team_key in keys and f"orch:{EVENT_ID}" in keys, f"solver channels: {keys}"
ok("solver channels list")

posted = aegisx.channels.post("#team", "solver contract post")
assert posted.channel_key == team_key
aegisx.ask("contract ask", urgent=False)
ok("solver channels post + ask")

mine = aegisx.agents.get(SOLVER_ID)
assert mine.agent["id"] == SOLVER_ID
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
