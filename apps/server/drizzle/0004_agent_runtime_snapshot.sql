PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_agent_id` text,
	`name` text NOT NULL,
	`task` text,
	`status` text NOT NULL,
	`session_path` text,
	`runtime_snapshot` text,
	`summary` text,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_agents_status_check" CHECK("status" in ('running', 'idle', 'paused', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
INSERT INTO `__new_run_agents`("id", "run_id", "parent_agent_id", "name", "task", "status", "session_path", "summary", "error", "created_at", "started_at", "updated_at", "completed_at") SELECT "id", "run_id", "parent_agent_id", "name", "task", "status", "session_path", "summary", "error", "created_at", "started_at", "updated_at", "completed_at" FROM `run_agents`;--> statement-breakpoint
DROP TABLE `run_agents`;--> statement-breakpoint
ALTER TABLE `__new_run_agents` RENAME TO `run_agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `run_agents_run_id_idx` ON `run_agents` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_agents_parent_agent_id_idx` ON `run_agents` (`parent_agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_agents_main_unique` ON `run_agents` (`run_id`) WHERE "run_agents"."parent_agent_id" is null;
