-- v9: unify the model representation into a single canonical ref string.
--
-- runs/agents previously stored five denormalized model columns
-- (provider/provider_label/model_id/model_label/thinking_level). v9 collapses
-- them into one `model` text column holding the canonical model ref
-- (`<providerKey>/<modelId>:<effort>` or `alias:<id>`), resolved to a concrete
-- provider+model at use time. This is the same "model + reasoning effort"
-- string used everywhere else (orchestration slot config, model-switch API,
-- aliases), so the whole system speaks one representation.
--
-- Migration strategy (same as the v8 run migration): the execution-state
-- tables are
-- transient and the column change is structural, so DROP+recreate runs/agents
-- (cascade-wiping sessions/session_entries) rather than an in-place ALTER.
-- Catalog/history tables (events, challenges, challenge_flags, ...) are
-- untouched. run_queue is preserved (pending items survive; rows referencing
-- wiped runs cascade-delete, which is correct — those runs are gone).
-- scheduler_config is preserved but its model_id is cleared: v8 stored a
-- ProviderModel.id UUID there, which is not a valid v9 ref string, so force a
-- re-pick (the value is nullable and falls back to the global default).

-- === drop v8 execution-state tables (child → parent) ========================
-- sessions/session_entries cascade under agents; run_queue.run_id cascades
-- under runs (pending items with null run_id survive).

DROP TABLE `session_entries`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint

-- === recreate runs (single `model` ref column; v9) ==========================

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
	`model` text NOT NULL,
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

-- === recreate agents (single `model` ref column; v9) ========================

CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`slot` text NOT NULL,
	`role` text NOT NULL,
	`parent_agent_id` text,
	`is_entry` integer DEFAULT false NOT NULL,
	`model` text NOT NULL,
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

-- === recreate sessions / session_entries (unchanged shape; v9) ==============

CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cwd` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `sessions_agent_id_idx` ON `sessions` (`agent_id`);--> statement-breakpoint

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

-- === scheduler_config: clear the v8 UUID model_id (not a valid v9 ref) ======

UPDATE `scheduler_config` SET `model_id` = NULL;
