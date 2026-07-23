CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt_hint` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_platforms` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`credential` text NOT NULL,
	`remote_event_id` text NOT NULL,
	`source_key` text NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text,
	`points` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `challenges_event_id_idx` ON `challenges` (`event_id`);
--> statement-breakpoint
CREATE TABLE `challenge_remote` (
	`challenge_id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`remote_id` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`solved` integer DEFAULT false NOT NULL,
	`target_supported` integer DEFAULT false NOT NULL,
	`target_ignored` integer DEFAULT false NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`target_info` text DEFAULT '[]' NOT NULL,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_remote_source_unique` ON `challenge_remote` (`source_key`,`remote_id`);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`original_name` text NOT NULL,
	`storage_key` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`remote_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_storage_key_unique` ON `attachments` (`storage_key`);
--> statement-breakpoint
CREATE INDEX `attachments_challenge_id_idx` ON `attachments` (`challenge_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_challenge_remote_unique` ON `attachments` (`challenge_id`,`remote_id`) WHERE "attachments"."remote_id" is not null;
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`status` text NOT NULL,
	`model_json` text NOT NULL,
	`env_json` text NOT NULL,
	`prompt_json` text NOT NULL,
	`workspace_path` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	`summary` text,
	`pending_finish_summary` text,
	`flag` text,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('running', 'paused', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `runs_challenge_id_idx` ON `runs` (`challenge_id`);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_agent_id` text,
	`name` text NOT NULL,
	`task` text,
	`status` text NOT NULL,
	`runtime_snapshot` text,
	`context_summary` text,
	`context_through_seq` integer,
	`summary` text,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agents_status_check" CHECK("agents"."status" in ('running', 'idle', 'paused', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `agents_run_id_idx` ON `agents` (`run_id`);
--> statement-breakpoint
CREATE INDEX `agents_parent_agent_id_idx` ON `agents` (`parent_agent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_main_unique` ON `agents` (`run_id`) WHERE "agents"."parent_agent_id" is null;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`client_message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_role_check" CHECK("messages"."role" in ('user', 'assistant', 'toolResult', 'notice'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_agent_seq_unique` ON `messages` (`agent_id`,`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_agent_client_unique` ON `messages` (`agent_id`,`client_message_id`) WHERE "messages"."client_message_id" is not null;
--> statement-breakpoint
CREATE INDEX `messages_agent_id_idx` ON `messages` (`agent_id`);
--> statement-breakpoint
CREATE TABLE `agent_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`usage` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_usage_agent_id_idx` ON `agent_usage` (`agent_id`);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`flag` text NOT NULL,
	`status` text NOT NULL,
	`remote_id` text,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "submissions_status_check" CHECK("submissions"."status" in ('pending', 'accepted', 'rejected', 'partial', 'already_solved', 'rate_limited', 'error'))
);
--> statement-breakpoint
CREATE INDEX `submissions_run_id_idx` ON `submissions` (`run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_run_flag_unique` ON `submissions` (`run_id`,`flag`);
--> statement-breakpoint
CREATE TABLE `platform_request_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_headers` text NOT NULL,
	`request_body` text,
	`status` integer,
	`response_headers` text,
	`response_body` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `platform_request_log_created_at_idx` ON `platform_request_log` (`created_at`);
