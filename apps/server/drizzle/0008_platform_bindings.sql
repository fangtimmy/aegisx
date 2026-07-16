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
INSERT INTO `event_platforms` (`event_id`, `type`, `base_url`, `credential`, `remote_event_id`, `source_key`, `last_synced_at`, `created_at`, `updated_at`)
SELECT `id`, `platform_type`, `platform_base_url`, `platform_credential`, `remote_event_id`, json_array(`platform_type`, rtrim(`platform_base_url`, '/'), `remote_event_id`), `last_synced_at`, `created_at`, `updated_at`
FROM `events`
WHERE `platform_type` IS NOT NULL AND `platform_base_url` IS NOT NULL AND `platform_credential` IS NOT NULL AND `remote_event_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `challenges` ADD `remote_source_key` text;
--> statement-breakpoint
UPDATE `challenges`
SET `remote_source_key` = (
	SELECT json_array(`platform_type`, rtrim(`platform_base_url`, '/'), `remote_event_id`)
	FROM `events`
	WHERE `events`.`id` = `challenges`.`event_id`
)
WHERE `remote_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `challenges` ADD `remote_available` integer DEFAULT true NOT NULL;
--> statement-breakpoint
DROP INDEX `challenges_event_remote_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `challenges_event_remote_source_unique` ON `challenges` (`event_id`, `remote_source_key`, `remote_id`) WHERE `remote_id` is not null;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `platform_type`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `platform_base_url`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `platform_credential`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `remote_event_id`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `last_synced_at`;
