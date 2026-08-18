"""Unit tests for the SDK time visibility + wire mapping (v19). Zero
dependencies — stdlib unittest.

Run from apps/sdk/python (uv per project convention):

    uv run python -m unittest test_models -v
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aegisx.models import (
    AgentSummary,
    ChannelFile,
    ChannelMessage,
    fmt_ms,
    from_dict,
)


def iso_ago(seconds: int) -> str:
    """ISO-8601 UTC timestamp `seconds` in the past (server format, Z suffix)."""
    return (
        datetime.now(timezone.utc) - timedelta(seconds=seconds)
    ).isoformat().replace("+00:00", "Z")


def iso_ahead(seconds: int) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=seconds)
    ).isoformat().replace("+00:00", "Z")


def agent_wire(**overrides: object) -> dict:
    base: dict = {
        "id": "a-1",
        "eventId": "evt-1",
        "challengeId": "ch-1",
        "challengeName": "Test Challenge",
        "role": "solver",
        "name": "agent-a1",
        "model": "openai/gpt-4o-mini:off",
        "status": "running",
        "source": "manual",
        "prompt": None,
        "summary": None,
        "error": None,
        "deadlineAt": iso_ahead(300),
        "lastTimeoutAt": None,
        "createdAt": iso_ago(3600),
        "startedAt": iso_ago(600),
        "updatedAt": iso_ago(30),
        "completedAt": None,
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


class TestAgentTimeProperties(unittest.TestCase):
    def test_from_dict_maps_deadline_at(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(deadlineAt="2025-01-01T00:00:00.000Z"))
        assert agent is not None
        self.assertEqual(agent.deadline_at, "2025-01-01T00:00:00.000Z")

    def test_elapsed_ms(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(startedAt=iso_ago(30)))
        assert agent is not None
        elapsed = agent.elapsed_ms
        assert elapsed is not None
        self.assertTrue(29_000 <= elapsed <= 31_000, elapsed)

    def test_elapsed_ms_none_before_start(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(startedAt=None))
        assert agent is not None
        self.assertIsNone(agent.elapsed_ms)

    def test_deadline_remain_ms(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(deadlineAt=iso_ahead(120)))
        assert agent is not None
        remain = agent.deadline_remain_ms
        assert remain is not None
        self.assertTrue(119_000 <= remain <= 121_000)

    def test_deadline_remain_ms_none_without_deadline(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(deadlineAt=None))
        assert agent is not None
        self.assertIsNone(agent.deadline_remain_ms)

    def test_deadline_remain_ms_none_when_terminal(self) -> None:
        agent = from_dict(
            AgentSummary, agent_wire(status="completed", deadlineAt=iso_ago(60))
        )
        assert agent is not None
        self.assertIsNone(agent.deadline_remain_ms)

    def test_deadline_remain_ms_negative_when_over(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(deadlineAt=iso_ago(60)))
        assert agent is not None
        remain = agent.deadline_remain_ms
        assert remain is not None
        self.assertLess(remain, 0)

    def test_overdue(self) -> None:
        over = from_dict(AgentSummary, agent_wire(deadlineAt=iso_ago(60)))
        assert over is not None
        self.assertTrue(over.overdue)
        fine = from_dict(AgentSummary, agent_wire(deadlineAt=iso_ahead(300)))
        assert fine is not None
        self.assertFalse(fine.overdue)
        none = from_dict(AgentSummary, agent_wire(deadlineAt=None))
        assert none is not None
        self.assertFalse(none.overdue)

    def test_last_activity_age_ms(self) -> None:
        agent = from_dict(AgentSummary, agent_wire(updatedAt=iso_ago(5)))
        assert agent is not None
        self.assertTrue(4_000 <= agent.last_activity_age_ms <= 6_000)

    def test_idle_age_ms(self) -> None:
        agent = from_dict(
            AgentSummary, agent_wire(status="idle", updatedAt=iso_ago(12))
        )
        assert agent is not None
        self.assertTrue(11_000 <= agent.idle_age_ms <= 13_000)


def message_wire(**overrides: object) -> dict:
    base: dict = {
        "id": 7,
        "channelKey": "team:ch-1",
        "authorType": "agent",
        "authorAgentId": "a-1",
        "authorName": "agent-a1",
        "body": "exp ready",
        "meta": {"urgent": True, "agentId": "a-1"},
        "createdAt": "2025-01-01T00:00:00.000Z",
        "files": [
            {"path": "shared/from-a1/exp.py", "filename": "exp.py", "size": 4300},
            {"path": "shared/upload-1/notes.txt", "filename": "notes.txt", "size": 90},
        ],
    }
    base.update(overrides)
    return base


class TestChannelMessageWire(unittest.TestCase):

    def test_files_built_as_channel_file(self) -> None:
        message = from_dict(ChannelMessage, message_wire())
        assert message is not None
        self.assertEqual(len(message.files), 2)
        for file in message.files:
            self.assertIsInstance(file, ChannelFile)
        self.assertEqual(message.files[0].filename, "exp.py")
        self.assertEqual(message.files[0].path, "shared/from-a1/exp.py")
        self.assertEqual(message.files[1].size, 90)

    def test_files_none_stays_empty_list_default(self) -> None:
        message = from_dict(ChannelMessage, message_wire(files=None))
        assert message is not None
        self.assertIsNone(message.files)

    def test_meta_stays_plain_dict(self) -> None:
        message = from_dict(ChannelMessage, message_wire())
        assert message is not None
        self.assertEqual(message.meta["agentId"], "a-1")


if __name__ == "__main__":
    unittest.main()
