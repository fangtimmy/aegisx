-- 0009: scheduler inbox delivery history (schema v15).
--
-- One row per flushed digest — the exact text steered into the orchestrator.
-- Append-only; the live backlog stays in memory (scheduler-inbox.ts), this
-- table only records what WAS delivered (complete history, survives restarts).
CREATE TABLE `scheduler_inbox_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduler_inbox_digests_event_idx` ON `scheduler_inbox_digests` (`event_id`,`created_at`);
