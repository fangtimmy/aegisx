ALTER TABLE `runs` ADD `pending_completion_summary` text;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `runtime_id` text;
--> statement-breakpoint
UPDATE `agent_messages` SET `runtime_id` = `id` WHERE `runtime_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_agent_runtime_unique` ON `agent_messages` (`agent_id`,`runtime_id`);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL REFERENCES `runs`(`id`) ON DELETE cascade,
	`type` text NOT NULL,
	`agent_id` text REFERENCES `run_agents`(`id`) ON DELETE cascade,
	`entity_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_events_run_id_idx` ON `run_events` (`run_id`,`id`);
