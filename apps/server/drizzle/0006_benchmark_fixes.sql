-- 0006: benchmark fixes (W2 per-event queue state + W3 scheduler pause).
--
-- Two structural changes, one migration:
--
-- 1. queue_state — per-event queue pause state (W2.1). One row per event;
--    absent row = running (a fresh event's queue drains immediately, no
--    explicit enable). pause blocks FUTURE launches only — already-running
--    runs keep going (pause ≠ kill) and enqueue/edit/reorder/remove still
--    work. Boot recovery (recoverOnBoot) upserts 'paused' for every event
--    with visible items (pending/running/failed); the user resumes.
-- 2. scheduler_config.paused — scheduler disabled flag (W3.1). While 1 the
--    event's run-lifecycle events are dropped before they reach the
--    orchestrator (silent; the container is kept warm). The flag is writable
--    even with no scheduler run (presets the next start).
CREATE TABLE `queue_state` (
	`event_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
ALTER TABLE `scheduler_config` ADD COLUMN `paused` integer DEFAULT false NOT NULL;
