-- 0010: unified message layer — channels (schema v16, docs/im-channels.md).
--
-- Additive: channels / channel_messages / channel_reads / channel_files.
-- DROP scheduler_inbox_digests — the recap messages stored back into the
-- scheduler DM channel replace it as the delivery history (rows are
-- historical only; local data, no migration).
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`run_id` text,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_agent_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT `channels_scope_type_check` CHECK (`scope_type` in ('run', 'event')),
	CONSTRAINT `channels_kind_check` CHECK (`kind` in ('team', 'announce', 'dm')),
	CONSTRAINT `channels_dm_target_check` CHECK ((`kind` != 'dm') or (`target_agent_id` is not null)),
	CONSTRAINT `channels_scope_run_check` CHECK ((`scope_type` != 'run') or (`run_id` is not null)),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channels_run_id_idx` ON `channels` (`run_id`);
--> statement-breakpoint
CREATE INDEX `channels_event_id_idx` ON `channels` (`event_id`);
--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`author_type` text NOT NULL,
	`author_agent_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `channel_messages_kind_check` CHECK (`kind` in ('text', 'recap')),
	CONSTRAINT `channel_messages_author_type_check` CHECK (`author_type` in ('system', 'user', 'agent')),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_messages_channel_id_idx` ON `channel_messages` (`channel_id`,`id`);
--> statement-breakpoint
CREATE TABLE `channel_reads` (
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`last_read_msg_id` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`channel_id`, `agent_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_files` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `channel_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_files_message_id_idx` ON `channel_files` (`message_id`);
--> statement-breakpoint
DROP TABLE `scheduler_inbox_digests`;
