CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`agent_id` text,
	`entity_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_id_idx` ON `run_events` (`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `agent_inbox` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `runtime_id` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_agent_runtime_unique` ON `agent_messages` (`agent_id`,`runtime_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `pending_completion_summary` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `default_thinking_level` text DEFAULT 'off' NOT NULL;