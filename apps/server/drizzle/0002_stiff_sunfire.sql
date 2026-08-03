-- Wipe legacy (jsonl-backed) runs: their message history lived in run_events,
-- which is dropped below. Cascade (FKs ON during migrate) deletes their agents,
-- run_events, submissions, sessions and session_entries. db (session_entries-
-- backed) runs — whose main agent session_file is a session id, not a .jsonl
-- path — are kept.
DELETE FROM `runs`
WHERE `id` IN (
  SELECT `run_id` FROM `agents`
  WHERE `role` = 'main' AND `session_file` LIKE '%.jsonl'
);--> statement-breakpoint
DROP TABLE `run_events`;
