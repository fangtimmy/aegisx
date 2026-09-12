CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text DEFAULT '' NOT NULL,
	`event_id` text NOT NULL,
	`challenge_id` text,
	`role` text NOT NULL,
	`name` text,
	`model` text NOT NULL,
	`system_prompt` text NOT NULL,
	`tools` text NOT NULL,
	`tool_definitions` text,
	`status` text NOT NULL,
	`session_file` text,
	`prompt` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`timeout_ms` integer,
	`deadline_at` text,
	`last_timeout_at` text,
	`queue_item_id` text,
	`error` text,
	`summary` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agents_role_check" CHECK("agents"."role" in ('solver', 'orchestrator')),
	CONSTRAINT "agents_status_check" CHECK("agents"."status" in ('running', 'idle', 'completed', 'aborted', 'failed')),
	CONSTRAINT "agents_source_check" CHECK("agents"."source" in ('manual', 'scheduler'))
);
--> statement-breakpoint
CREATE INDEX `agents_event_id_idx` ON `agents` (`event_id`);--> statement-breakpoint
CREATE INDEX `agents_challenge_id_idx` ON `agents` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_event_orchestrator_unique` ON `agents` (`event_id`) WHERE "agents"."role" = 'orchestrator';--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_unique` ON `agents` (`token`) WHERE "agents"."token" != '';--> statement-breakpoint
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
CREATE UNIQUE INDEX `attachments_storage_key_unique` ON `attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `attachments_challenge_id_idx` ON `attachments` (`challenge_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_challenge_remote_unique` ON `attachments` (`challenge_id`,`remote_id`) WHERE "attachments"."remote_id" is not null;--> statement-breakpoint
CREATE TABLE `challenge_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`flag` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`agent_id` text,
	`remote_id` text,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "challenge_flags_status_check" CHECK("challenge_flags"."status" in ('pending', 'accepted', 'rejected', 'error')),
	CONSTRAINT "challenge_flags_source_check" CHECK("challenge_flags"."source" in ('agent', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_flags_challenge_flag_unique` ON `challenge_flags` (`challenge_id`,`flag`);--> statement-breakpoint
CREATE INDEX `challenge_flags_challenge_id_idx` ON `challenge_flags` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `challenge_flags_agent_id_idx` ON `challenge_flags` (`agent_id`);--> statement-breakpoint
CREATE TABLE `challenge_remote` (
	`challenge_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`source_key` text NOT NULL,
	`remote_id` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`solved` integer DEFAULT false NOT NULL,
	`target_supported` integer DEFAULT false NOT NULL,
	`target_ignored` integer DEFAULT false NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`target_info` text DEFAULT '[]' NOT NULL,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_remote_source_unique` ON `challenge_remote` (`event_id`,`source_key`,`remote_id`);--> statement-breakpoint
CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text,
	`points` integer,
	`manual_solve_state` text DEFAULT 'unsolved' NOT NULL,
	`required_flags` integer,
	`solved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "challenges_manual_solve_state_check" CHECK("challenges"."manual_solve_state" in ('solved', 'partial', 'unsolved'))
);
--> statement-breakpoint
CREATE INDEX `challenges_event_id_idx` ON `challenges` (`event_id`);--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_key` text NOT NULL,
	`author_type` text NOT NULL,
	`author_agent_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "channel_messages_author_type_check" CHECK("channel_messages"."author_type" in ('system', 'user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `channel_messages_channel_key_idx` ON `channel_messages` (`channel_key`,`id`);--> statement-breakpoint
CREATE TABLE `channel_reads` (
	`channel_key` text NOT NULL,
	`reader_key` text NOT NULL,
	`last_read_msg_id` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`channel_key`, `reader_key`)
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
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt_brief` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
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
CREATE INDEX `platform_request_log_created_at_idx` ON `platform_request_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`plugin` text NOT NULL,
	`key` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_templates_plugin_key_unique` ON `prompt_templates` (`plugin`,`key`);--> statement-breakpoint
CREATE TABLE `queue_state` (
	`event_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scheduler_config` (
	`event_id` text PRIMARY KEY NOT NULL,
	`model_id` text,
	`instruction` text DEFAULT '' NOT NULL,
	`max_concurrent_targets` integer DEFAULT 1 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`notify_team_on_flag` integer DEFAULT true NOT NULL,
	`stop_siblings_on_solve` integer DEFAULT true NOT NULL,
	`stop_target_on_solve` integer DEFAULT true NOT NULL,
	`stop_submitter_on_solve` integer DEFAULT false NOT NULL,
	`next_task_policy` text DEFAULT 'eager' NOT NULL,
	`urgent_team_messages` integer DEFAULT true NOT NULL,
	`block_spawn_on_solved` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`parent_id` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`meta` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_entries_session_seq_unique` ON `session_entries` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_agent_seq_idx` ON `session_entries` (`agent_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_session_type_idx` ON `session_entries` (`session_id`,`type`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cwd` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_agent_id_idx` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE TABLE `spawn_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`ord` integer NOT NULL,
	`challenge_id` text NOT NULL,
	`params` text NOT NULL,
	`timeout_ms` integer,
	`prompt` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`agent_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "spawn_queue_source_check" CHECK("spawn_queue"."source" in ('manual', 'scheduler')),
	CONSTRAINT "spawn_queue_status_check" CHECK("spawn_queue"."status" in ('pending', 'running', 'done', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `spawn_queue_event_ord_idx` ON `spawn_queue` (`event_id`,`ord`);--> statement-breakpoint
CREATE INDEX `spawn_queue_status_idx` ON `spawn_queue` (`status`);--> statement-breakpoint
CREATE INDEX `spawn_queue_agent_id_idx` ON `spawn_queue` (`agent_id`);