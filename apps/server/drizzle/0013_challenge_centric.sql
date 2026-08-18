-- 0013: v19 challenge-centric model (docs/model-v19-challenge-centric.md §五).
--
-- DESTRUCTIVE, old execution data dropped by design (local single-user tool;
-- events/challenges/providers/settings/prompt templates survive). The run
-- layer is deleted: agents carry challengeId directly, the workspace is a
-- derived path under data/events/<eid>/challenges/<cid>/, and the queue
-- becomes a spawn queue with append semantics.
--
-- Drop order is FK-child-first (session_entries → sessions → run_queue →
-- channel_files → channel_messages → channel_reads → agents → runs →
-- challenge_flags); the channel tables are rebuilt EMPTY (agentId-signed
-- history starts fresh), challenge_flags rows are dropped (platform-side
-- solved state re-syncs), and channel attachments move from the
-- channel_files store to the per-challenge shared/ workspace tree (runtime
-- copies; no table).
DROP TABLE `session_entries`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP TABLE `run_queue`;--> statement-breakpoint
DROP TABLE `channel_files`;--> statement-breakpoint
DROP TABLE `channel_messages`;--> statement-breakpoint
DROP TABLE `channel_reads`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
DROP TABLE `challenge_flags`;--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
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
	CONSTRAINT `agents_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agents_challenge_id_challenges_id_fk` FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agents_role_check` CHECK (`role` in ('solver', 'orchestrator')),
	CONSTRAINT `agents_status_check` CHECK (`status` in ('running', 'idle', 'completed', 'aborted', 'failed')),
	CONSTRAINT `agents_source_check` CHECK (`source` in ('manual', 'scheduler'))
);--> statement-breakpoint
CREATE INDEX `agents_event_id_idx` ON `agents` (`event_id`);--> statement-breakpoint
CREATE INDEX `agents_challenge_id_idx` ON `agents` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_event_orchestrator_unique` ON `agents` (`event_id`) WHERE role = 'orchestrator';--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cwd` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `sessions_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `sessions_agent_id_idx` ON `sessions` (`agent_id`);--> statement-breakpoint
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
	CONSTRAINT `session_entries_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `session_entries_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `session_entries_session_seq_unique` ON `session_entries` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_agent_seq_idx` ON `session_entries` (`agent_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_entries_session_type_idx` ON `session_entries` (`session_id`,`type`);--> statement-breakpoint
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
	CONSTRAINT `spawn_queue_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `spawn_queue_challenge_id_challenges_id_fk` FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `spawn_queue_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `spawn_queue_source_check` CHECK (`source` in ('manual', 'scheduler')),
	CONSTRAINT `spawn_queue_status_check` CHECK (`status` in ('pending', 'running', 'done', 'cancelled', 'failed'))
);--> statement-breakpoint
CREATE INDEX `spawn_queue_event_ord_idx` ON `spawn_queue` (`event_id`,`ord`);--> statement-breakpoint
CREATE INDEX `spawn_queue_status_idx` ON `spawn_queue` (`status`);--> statement-breakpoint
CREATE INDEX `spawn_queue_agent_id_idx` ON `spawn_queue` (`agent_id`);--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_key` text NOT NULL,
	`author_type` text NOT NULL,
	`author_agent_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `channel_messages_author_type_check` CHECK (`author_type` in ('system', 'user', 'agent'))
);--> statement-breakpoint
CREATE INDEX `channel_messages_channel_key_idx` ON `channel_messages` (`channel_key`,`id`);--> statement-breakpoint
CREATE TABLE `channel_reads` (
	`channel_key` text NOT NULL,
	`reader_key` text NOT NULL,
	`last_read_msg_id` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `channel_reads_channel_key_reader_key_pk` PRIMARY KEY (`channel_key`,`reader_key`)
);--> statement-breakpoint
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
	CONSTRAINT `challenge_flags_challenge_id_challenges_id_fk` FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `challenge_flags_status_check` CHECK (`status` in ('pending', 'accepted', 'rejected', 'error')),
	CONSTRAINT `challenge_flags_source_check` CHECK (`source` in ('agent', 'manual'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_flags_challenge_flag_unique` ON `challenge_flags` (`challenge_id`,`flag`);--> statement-breakpoint
CREATE INDEX `challenge_flags_challenge_id_idx` ON `challenge_flags` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `challenge_flags_agent_id_idx` ON `challenge_flags` (`agent_id`);
