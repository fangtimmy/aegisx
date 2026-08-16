"""Unit tests for the SDK time visibility + wire mapping
(docs/scheduler-inbox.md §3). Zero dependencies — stdlib unittest.

Run from apps/sdk/python (uv per project convention):

    uv run python -m unittest test_models -v
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aegisx.models import AgentSummary, Run, fmt_ms, from_dict


def iso_ago(seconds: int) -> str:
    """ISO-8601 UTC timestamp `seconds` in the past (server format, Z suffix)."""
    return (
        datetime.now(timezone.utc) - timedelta(seconds=seconds)
    ).isoformat().replace("+00:00", "Z")


def iso_ahead(seconds: int) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=seconds)
    ).isoformat().replace("+00:00", "Z")


def run_wire(**overrides: object) -> dict:
    base: dict = {
        "id": "run-1",
        "scopeType": "challenge",
        "eventId": "evt-1",
        "challengeId": "ch-1",
        "challengeName": "Test Challenge",
        "status": "running",
        "finishing": False,
        "source": "scheduler",
        "targetSupported": False,
        "provider": "prov-1",
        "modelId": "model-1",
        "modelName": "gpt-4o-mini",
        "thinkingLevel": "off",
        "environment": "container",
        "image": "img",
        "cpus": 2,
        "memoryMb": 1024,
        "pidsLimit": 128,
        "containerName": "c",
        "createdAt": iso_ago(3600),
        "startedAt": iso_ago(600),
        "updatedAt": iso_ago(30),
        "completedAt": None,
        "deadlineAt": iso_ahead(300),
        "lastTimeoutAt": None,
        "error": None,
        "summary": None,
        "hasAcceptedFlag": False,
    }
    base.update(overrides)
    return base


class TestFmtMs(unittest.TestCase):
    def test_formats(self) -> None:
        self.assertEqual(fmt_ms(3_500), "4s")
        self.assertEqual(fmt_ms(40_000), "40s")
        self.assertEqual(fmt_ms(60_000), "1m")
        self.assertEqual(fmt_ms(210_000), "3m30s")
        self.assertEqual(fmt_ms(1_380_000), "23m")
        self.assertEqual(fmt_ms(3_600_000), "1h")
        self.assertEqual(fmt_ms(3_660_000), "1h1m")

    def test_negative_marks_overdue(self) -> None:
        self.assertEqual(fmt_ms(-45_000), "-45s(超时)")
        self.assertEqual(fmt_ms(-210_000), "-3m30s(超时)")


class TestRunTimeProperties(unittest.TestCase):
    def test_from_dict_maps_deadline_at(self) -> None:
        run = from_dict(Run, run_wire(deadlineAt="2025-01-01T00:00:00.000Z"))
        assert run is not None
        self.assertEqual(run.deadline_at, "2025-01-01T00:00:00.000Z")

    def test_elapsed_ms(self) -> None:
        run = from_dict(Run, run_wire(startedAt=iso_ago(30)))
        assert run is not None
        # 30s ± tolerance (the clock moves between construction and assert).
        self.assertTrue(29_000 <= run.elapsed_ms <= 31_000, run.elapsed_ms)

    def test_elapsed_ms_none_before_start(self) -> None:
        run = from_dict(Run, run_wire(startedAt=None))
        assert run is not None
        self.assertIsNone(run.elapsed_ms)

    def test_deadline_remain_ms(self) -> None:
        run = from_dict(Run, run_wire(deadlineAt=iso_ahead(120)))
        assert run is not None
        self.assertTrue(119_000 <= run.deadline_remain_ms <= 121_000)

    def test_deadline_remain_ms_none_without_deadline(self) -> None:
        run = from_dict(Run, run_wire(deadlineAt=None))
        assert run is not None
        self.assertIsNone(run.deadline_remain_ms)

    def test_deadline_remain_ms_none_when_closed(self) -> None:
        run = from_dict(
            Run, run_wire(status="closed", deadlineAt=iso_ago(60))
        )
        assert run is not None
        self.assertIsNone(run.deadline_remain_ms)

    def test_deadline_remain_ms_negative_when_over(self) -> None:
        run = from_dict(Run, run_wire(deadlineAt=iso_ago(60)))
        assert run is not None
        self.assertLess(run.deadline_remain_ms, 0)

    def test_overdue(self) -> None:
        over = from_dict(Run, run_wire(deadlineAt=iso_ago(60)))
        assert over is not None
        self.assertTrue(over.overdue)
        fine = from_dict(Run, run_wire(deadlineAt=iso_ahead(300)))
        assert fine is not None
        self.assertFalse(fine.overdue)
        none = from_dict(Run, run_wire(deadlineAt=None))
        assert none is not None
        self.assertFalse(none.overdue)

    def test_last_activity_age_ms(self) -> None:
        run = from_dict(Run, run_wire(updatedAt=iso_ago(5)))
        assert run is not None
        self.assertTrue(4_000 <= run.last_activity_age_ms <= 6_000)


class TestAgentIdleAge(unittest.TestCase):
    def test_idle_age_ms(self) -> None:
        agent = from_dict(
            AgentSummary,
            {
                "id": "a-1",
                "runId": "run-1",
                "slot": "solver-1",
                "role": "solver",
                "parentAgentId": None,
                "isEntry": True,
                "name": "Solver 1",
                "task": None,
                "model": "prov/model:off",
                "status": "idle",
                "sessionFile": None,
                "createdAt": iso_ago(600),
                "startedAt": iso_ago(600),
                "updatedAt": iso_ago(12),
                "completedAt": None,
                "error": None,
            },
        )
        assert agent is not None
        self.assertTrue(11_000 <= agent.idle_age_ms <= 13_000)


if __name__ == "__main__":
    unittest.main()
