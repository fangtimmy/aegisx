PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Intentional reset: coding-agent JSONL runs cannot be resumed by the core Agent runtime.
DROP TABLE IF EXISTS `run_agents`;--> statement-breakpoint
DROP TABLE IF EXISTS `runs`;--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`status` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`model_config` text DEFAULT '{}' NOT NULL,
	`environment_config` text DEFAULT '{"type":"local"}' NOT NULL,
	`workspace_path` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	`summary` text,
	`flag` text,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_status_check" CHECK("status" in ('running', 'paused', 'completed', 'failed', 'stopped'))
);--> statement-breakpoint
CREATE INDEX `runs_challenge_id_idx` ON `runs` (`challenge_id`);--> statement-breakpoint
CREATE TABLE `run_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_agent_id` text,
	`name` text NOT NULL,
	`task` text,
	`status` text NOT NULL,
	`runtime_snapshot` text,
	`context_summary` text,
	`context_through_sequence` integer,
	`summary` text,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_agents_status_check" CHECK("status" in ('running', 'idle', 'paused', 'completed', 'failed', 'stopped'))
);--> statement-breakpoint
CREATE INDEX `run_agents_run_id_idx` ON `run_agents` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_agents_parent_agent_id_idx` ON `run_agents` (`parent_agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_agents_main_unique` ON `run_agents` (`run_id`) WHERE "run_agents"."parent_agent_id" is null;--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_agent_sequence_unique` ON `agent_messages` (`agent_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_messages_agent_id_idx` ON `agent_messages` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_inbox_kind_check" CHECK("kind" in ('user', 'child_result', 'resume'))
);--> statement-breakpoint
CREATE INDEX `agent_inbox_pending_idx` ON `agent_inbox` (`agent_id`,`delivered_at`);--> statement-breakpoint
CREATE TABLE `agent_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`usage` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `agent_usage_agent_id_idx` ON `agent_usage` (`agent_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
