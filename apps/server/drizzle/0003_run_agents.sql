CREATE TABLE `run_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_agent_id` text,
	`name` text NOT NULL,
	`task` text,
	`status` text NOT NULL,
	`session_path` text,
	`summary` text,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_agents_status_check" CHECK("run_agents"."status" in ('running', 'paused', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `run_agents_run_id_idx` ON `run_agents` (`run_id`);
--> statement-breakpoint
CREATE INDEX `run_agents_parent_agent_id_idx` ON `run_agents` (`parent_agent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_agents_main_unique` ON `run_agents` (`run_id`) WHERE `parent_agent_id` is null;
--> statement-breakpoint
INSERT INTO `run_agents` (
	`id`,
	`run_id`,
	`parent_agent_id`,
	`name`,
	`task`,
	`status`,
	`session_path`,
	`summary`,
	`error`,
	`created_at`,
	`started_at`,
	`updated_at`,
	`completed_at`
)
SELECT
	`id`,
	`id`,
	NULL,
	'Main agent',
	NULL,
	`status`,
	`session_path`,
	`summary`,
	`error`,
	`created_at`,
	`started_at`,
	`updated_at`,
	`completed_at`
FROM `runs`;
