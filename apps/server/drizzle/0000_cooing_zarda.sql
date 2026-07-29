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
CREATE UNIQUE INDEX `challenge_remote_source_unique` ON `challenge_remote` (`source_key`,`remote_id`);--> statement-breakpoint
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
CREATE INDEX `challenges_event_id_idx` ON `challenges` (`event_id`);--> statement-breakpoint
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
	`prompt_hint` text DEFAULT '' NOT NULL,
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
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`status` text NOT NULL,
	`launcher` text DEFAULT 'pi' NOT NULL,
	`provider` text NOT NULL,
	`provider_label` text,
	`model_id` text NOT NULL,
	`model_label` text,
	`pi_model_ref` text,
	`thinking_level` text DEFAULT 'off' NOT NULL,
	`image` text NOT NULL,
	`cpus` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`pids_limit` integer NOT NULL,
	`container_name` text NOT NULL,
	`workspace_path` text NOT NULL,
	`pi_session_id` text,
	`pi_session_file` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	`summary` text,
	`flag` text,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('running', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `runs_challenge_id_idx` ON `runs` (`challenge_id`);--> statement-breakpoint
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
CREATE INDEX `submissions_run_id_idx` ON `submissions` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_run_flag_unique` ON `submissions` (`run_id`,`flag`);