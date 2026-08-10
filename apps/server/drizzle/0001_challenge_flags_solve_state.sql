-- challenge_flags: per-challenge flag records (one-to-many / 一题多解).
-- Replaces v6 `runs.flag` (single) and the `submissions` audit table with a
-- unified, challenge-scoped flag store carrying verification status + lineage.
CREATE TABLE `challenge_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`flag` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`run_id` text,
	`remote_id` text,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "challenge_flags_status_check" CHECK("challenge_flags"."status" in ('pending', 'accepted', 'rejected', 'error')),
	CONSTRAINT "challenge_flags_source_check" CHECK("challenge_flags"."source" in ('run', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_flags_challenge_flag_unique` ON `challenge_flags` (`challenge_id`,`flag`);
--> statement-breakpoint
CREATE INDEX `challenge_flags_challenge_id_idx` ON `challenge_flags` (`challenge_id`);
--> statement-breakpoint
CREATE INDEX `challenge_flags_run_id_idx` ON `challenge_flags` (`run_id`);
--> statement-breakpoint
-- challenges.manual_solve_state: user-assigned solve-state override
-- (solved|partial|unsolved). NOTE: SQLite cannot attach a CHECK to a column
-- added via ALTER on an existing table; the value domain is enforced in the
-- application layer (PATCH /api/challenges/:id/solved validates via typebox).
ALTER TABLE `challenges` ADD `manual_solve_state` text NOT NULL DEFAULT 'unsolved';
--> statement-breakpoint
-- Migrate `submissions` rows → challenge_flags. Adapter verdicts collapse:
-- accepted/already_solved/partial → accepted (the flag itself was verified).
-- Accepted-class rows are inserted first so the (challenge_id, flag) unique
-- index keeps the strongest verdict on cross-run duplicates.
INSERT INTO `challenge_flags` (id, challenge_id, flag, status, source, run_id, remote_id, message, created_at, updated_at)
SELECT
	s.id,
	r.challenge_id,
	s.flag,
	CASE s.status
		WHEN 'accepted' THEN 'accepted'
		WHEN 'already_solved' THEN 'accepted'
		WHEN 'partial' THEN 'accepted'
		WHEN 'pending' THEN 'pending'
		WHEN 'rejected' THEN 'rejected'
		WHEN 'rate_limited' THEN 'error'
		ELSE 'error'
	END,
	'run',
	s.run_id,
	s.remote_id,
	s.message,
	s.created_at,
	s.updated_at
FROM `submissions` s
JOIN `runs` r ON r.id = s.run_id
ORDER BY (CASE WHEN s.status IN ('accepted', 'already_solved', 'partial') THEN 0 ELSE 1 END)
ON CONFLICT(challenge_id, flag) DO NOTHING;
--> statement-breakpoint
-- Migrate non-null `runs.flag` → challenge_flags (accepted, run-sourced).
-- Catches solved runs whose flag was never recorded as a submission row.
INSERT INTO `challenge_flags` (id, challenge_id, flag, status, source, run_id, remote_id, message, created_at, updated_at)
SELECT
	lower(hex(randomblob(16))),
	r.challenge_id,
	r.flag,
	'accepted',
	'run',
	r.id,
	NULL,
	NULL,
	r.updated_at,
	r.updated_at
FROM `runs` r
WHERE r.flag IS NOT NULL
ON CONFLICT(challenge_id, flag) DO NOTHING;
--> statement-breakpoint
DROP TABLE `submissions`;
--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `flag`;
