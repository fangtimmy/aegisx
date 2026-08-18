"""P1 smoke test for the aegisx SDK — run against a live server from the host.

Usage (from apps/sdk/python, uv per project convention):

    AEGISX_EVENT_ID=<event-id> uv run python smoke.py [--api-url http://127.0.0.1:3000]

Exercises the full scheduler loop against real endpoints:
status → snapshot → challenges → queue (enqueue+close+remove probe) → runs
(list/read) → agents → error contract. The enqueue probe launches a REAL run
when a slot is free (then closes+removes it); skipped when the launch
environment is unavailable. Prints PASS/FAIL per step; exits nonzero on
failure.
"""
from __future__ import annotations

import argparse
import sys

import aegisx
from aegisx import AegisxError
from aegisx.client import get_client

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=None)
    parser.add_argument("--event-id", default=None)
    args = parser.parse_args()

    if not (args.event_id or get_client().event_id):
        parser.error("pass --event-id or set AEGISX_EVENT_ID")
    aegisx.configure(api_url=args.api_url, event_id=args.event_id)

    print("== status ==")
    st = aegisx.status()
    print(f"  concurrency {st.running_count}/{st.max_concurrent_runs}")
    check("status caps", st.max_concurrent_runs > 0)

    print("== snapshot ==")
    snap = aegisx.snapshot()
    print(
        f"  {len(snap.challenges)} challenges, {len(snap.queue)} queue items, "
        f"{len(snap.runs)} runs, queue_state={snap.queue_state}"
    )
    check("snapshot challenges", isinstance(snap.challenges, list))
    check("snapshot status", snap.status is not None)
    check(
        "snapshot agents_by_run",
        all(
            isinstance(v, list)
            for v in snap.agents_by_run.values()
        ),
    )

    print("== challenges ==")
    challenges = aegisx.challenges.list()
    check("challenges.list", isinstance(challenges, list))
    if challenges:
        c = challenges[0]
        print(f"  first: {c.id} {c.points} {c.name} solved={c.solved_now}")
        one = aegisx.challenges.get(c.id)
        check("challenges.get", one.id == c.id and bool(one.description))
        check(
            "challenge fields",
            one.run_count >= 0 and one.solved_now in (True, False),
        )
    else:
        print("  (no challenges — skipping get)")

    print("== queue ==")
    items = aegisx.queue.list()
    check("queue.list", isinstance(items, list))
    # Enqueue probe: with a free slot this launches a REAL run (container +
    # solver prime) — close it right away to release resources, then remove.
    # Skipped (not failed) when the launch environment is unavailable (e.g.
    # the default model ref is not resolvable on this install).
    if challenges:
        try:
            probe = aegisx.queue.enqueue(
                challenges[0].id,
                strategy="smoke test probe — will be removed",
                timeout_ms=60_000,
            )
            check(
                "queue.enqueue",
                probe.status in ("pending", "running", "failed"),
                probe.status,
            )
            if probe.run_id:
                aegisx.runs.close(probe.run_id)
            aegisx.queue.remove(probe.id)
            gone = [i for i in aegisx.queue.list() if i.id == probe.id]
            check("queue.remove", not gone)
        except AegisxError as err:
            print(f"  SKIP queue.enqueue loop ({err.code}: {err.message[:80]})")

    print("== runs ==")
    runs = aegisx.runs.list()
    check("runs.list", isinstance(runs, list))
    if runs:
        r = runs[0]
        print(f"  first: {r.id} {r.status} {r.challenge_name} model={r.model_name}")
        rd = aegisx.runs.read(r.id)
        check("runs.read", rd.run.id == r.id and rd.agent is not None)
        print(f"    agent={rd.agent.slot if rd.agent else None} msgs={len(rd.messages)}")
        agents = aegisx.agents.list(r.id)
        check("agents.list", len(agents) > 0)
    else:
        print("  (no runs — skipping read/agents)")

    print("== error contract ==")
    try:
        aegisx.challenges.get("does-not-exist")
        check("error contract", False, "expected AegisxError")
    except AegisxError as err:
        check("error contract", err.code == "not_found", err.code)

    print()
    if FAILURES:
        print(f"SMOKE FAIL: {', '.join(FAILURES)}")
        return 1
    print("SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
