ALTER TABLE `events` ADD `platform_type` text;--> statement-breakpoint
ALTER TABLE `events` ADD `platform_base_url` text;--> statement-breakpoint
ALTER TABLE `events` ADD `platform_credential` text;--> statement-breakpoint
ALTER TABLE `events` ADD `remote_event_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `last_synced_at` text;--> statement-breakpoint
ALTER TABLE `challenges` ADD `remote_id` text;--> statement-breakpoint
ALTER TABLE `challenges` ADD `remote_solved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `challenges` ADD `remote_target` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `challenges` ADD `remote_updated_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `challenges_event_remote_unique` ON `challenges` (`event_id`,`remote_id`) WHERE `remote_id` is not null;--> statement-breakpoint
ALTER TABLE `attachments` ADD `remote_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_challenge_remote_unique` ON `attachments` (`challenge_id`,`remote_id`) WHERE `remote_id` is not null;
