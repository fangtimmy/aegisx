-- v8: unify run + orchestration ("统一 Run + 编排插件").
--
-- Migration strategy (spec §14.1): preserve catalog/history tables (events,
-- event_platforms, challenges, challenge_remote, attachments, challenge_flags,
-- platform_request_log) untouched; WIPE execution-state tables (their rows are
-- transient and the v8 structure differs substantially — a data-preserving
-- ALTER costs more than it is worth); CREATE the new tables.
--
-- Concretely: DROP the v7 execution tables (orchestrators, session_entries,
-- sessions, agents, runs) and recreate them at the v8 shape, then add
-- run_queue / scheduler_config / prompt_templates.
--
-- challenge_flags is kept, but its runs FK is DROPPED in v8 (run_id becomes a
-- plain column): a runs FK with ON DELETE CASCADE would wipe solve history
-- when the runs table is rebuilt below (SQLite fires cascade on the implicit
-- DELETE performed by DROP TABLE), and after the wipe historical runId values
-- dangle — which FK-ON + COMMIT cannot tolerate. So run-sourced flag rows keep
-- their runId as a historical value (no FK), and the flag/challenge
-- association survives intact.

-- === challenge_flags: drop the runs FK (v8) ==================================
-- v8 stores run_id as a PLAIN column (no FK to runs). Two reasons: (1) a runs
-- FK with ON DELETE CASCADE would wipe solve history when the execution-state
-- runs table is rebuilt below (SQLite fires cascade on the implicit DELETE
-- performed by DROP TABLE); (2) after the wipe, historical runId values dangle,
-- which FK-ON + COMMIT cannot tolerate. Rebuild the table once (rows preserved)
-- to drop the runs FK while keeping the challenges FK + checks + indexes.

CREATE TABLE `challenge_flags__v8` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`flag` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`run_id` text,
	`remote_id` text,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "challenge_flags_status_check" CHECK(`status` in ('pending', 'accepted', 'rejected', 'error')),
	CONSTRAINT "challenge_flags_source_check" CHECK(`source` in ('run', 'manual'))
);--> statement-breakpoint
INSERT INTO `challenge_flags__v8` (`id`, `challenge_id`, `flag`, `status`, `source`, `run_id`, `remote_id`, `message`, `created_at`, `updated_at`) SELECT `id`, `challenge_id`, `flag`, `status`, `source`, `run_id`, `remote_id`, `message`, `created_at`, `updated_at` FROM `challenge_flags`;--> statement-breakpoint
DROP TABLE `challenge_flags`;--> statement-breakpoint
ALTER TABLE `challenge_flags__v8` RENAME TO `challenge_flags`;--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_flags_challenge_flag_unique` ON `challenge_flags` (`challenge_id`,`flag`);--> statement-breakpoint
CREATE INDEX `challenge_flags_challenge_id_idx` ON `challenge_flags` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `challenge_flags_run_id_idx` ON `challenge_flags` (`run_id`);--> statement-breakpoint

-- === drop v7 execution-state tables (child → parent) =========================

DROP TABLE `session_entries`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
DROP TABLE `orchestrators`;--> statement-breakpoint

-- === recreate runs (merged orchestrators; v8) ================================

CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`event_id` text NOT NULL,
	`challenge_id` text,
	`orchestration` text NOT NULL,
	`status` text NOT NULL,
	`finishing` integer DEFAULT false NOT NULL,
	`image` text NOT NULL,
	`cpus` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`pids_limit` integer NOT NULL,
	`container_name` text NOT NULL,
	`workspace_path` text NOT NULL,
	`session_dir` text NOT NULL,
	`provider` text NOT NULL,
	`provider_label` text,
	`model_id` text NOT NULL,
	`model_label` text,
	`thinking_level` text DEFAULT 'off' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`timeout_ms` integer,
	`deadline_at` text,
	`summary` text,
	`error` text,
	`queue_item_id` text,
	`params` text DEFAULT '{}' NOT NULL,
	`last_timeout_at` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`queue_item_id`) REFERENCES `run_queue`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_scope_type_check" CHECK("runs"."scope_type" in ('challenge', 'event')),
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('running', 'idle', 'closed')),
	CONSTRAINT "runs_source_check" CHECK("runs"."source" in ('manual', 'scheduler'))
);--> statement-breakpoint
CREATE INDEX `runs_challenge_id_idx` ON `runs` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `runs_scope_event_idx` ON `runs` (`scope_type`,`event_id`);--> statement-breakpoint
CREATE INDEX `runs_orchestration_idx` ON `runs` (`orchestration`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_event_scheduler_unique` ON `runs` (`event_id`) WHERE "runs"."scope_type" = 'event';--> statement-breakpoint

-- === run_queue (new) =========================================================

CREATE TABLE `run_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`ord` integer NOT NULL,
	`challenge_id` text NOT NULL,
	`orchestration` text NOT NULL,
	`params` text NOT NULL,
	`timeout_ms` integer,
	`prompt` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_queue_source_check" CHECK("run_queue"."source" in ('manual', 'scheduler')),
	CONSTRAINT "run_queue_status_check" CHECK("run_queue"."status" in ('pending', 'running', 'done', 'cancelled', 'failed'))
);--> statement-breakpoint
CREATE INDEX `run_queue_event_ord_idx` ON `run_queue` (`event_id`,`ord`);--> statement-breakpoint
CREATE INDEX `run_queue_status_idx` ON `run_queue` (`status`);--> statement-breakpoint
CREATE INDEX `run_queue_run_id_idx` ON `run_queue` (`run_id`);--> statement-breakpoint

-- === agents (generalized + snapshot; v8) =====================================

CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`slot` text NOT NULL,
	`role` text NOT NULL,
	`parent_agent_id` text,
	`is_entry` integer DEFAULT false NOT NULL,
	`provider` text NOT NULL,
	`provider_label` text,
	`model_id` text NOT NULL,
	`model_label` text,
	`thinking_level` text DEFAULT 'off' NOT NULL,
	`system_prompt` text NOT NULL,
	`tools` text NOT NULL,
	`status` text NOT NULL,
	`session_file` text,
	`name` text,
	`task` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agents_status_check" CHECK("agents"."status" in ('running', 'idle', 'completed', 'aborted', 'failed'))
);--> statement-breakpoint
CREATE INDEX `agents_run_id_idx` ON `agents` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_run_entry_unique` ON `agents` (`run_id`) WHERE "agents"."is_entry" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_run_slot_unique` ON `agents` (`run_id`,`slot`);--> statement-breakpoint

-- === sessions (hang off agentId; v8) =========================================

CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cwd` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `sessions_agent_id_idx` ON `sessions` (`agent_id`);--> statement-breakpoint

-- === session_entries (drop owner dims; redundant runId kept) =================

CREATE TABLE `session_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`parent_id` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `session_entries_session_seq_unique` ON `session_entries` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_agent_seq_idx` ON `session_entries` (`agent_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_run_seq_idx` ON `session_entries` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_session_type_idx` ON `session_entries` (`session_id`,`type`);--> statement-breakpoint

-- === scheduler_config (new; replaces orchestrators config) ===================

CREATE TABLE `scheduler_config` (
	`event_id` text PRIMARY KEY NOT NULL,
	`model_id` text,
	`instruction` text DEFAULT '' NOT NULL,
	`max_concurrent_targets` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

-- === prompt_templates (new; builtin rows seeded at runtime, not here) ========

CREATE TABLE `prompt_templates` (
	`plugin` text NOT NULL,
	`key` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_templates_plugin_key_unique` ON `prompt_templates` (`plugin`,`key`);
