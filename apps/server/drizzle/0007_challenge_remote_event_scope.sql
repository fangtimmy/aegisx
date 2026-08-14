-- 0007: event-scoped challenge_remote.
--
-- The unique index was (source_key, remote_id) GLOBAL: binding the same
-- platform to two events made the second event's import of an already-imported
-- challenge insert the challenge row fine but blow up on the remote mapping
-- insert (unique violation), leaving orphan challenge rows with no remote
-- mapping (unsyncable, no target/flag support) and a per-item "could not be
-- stored" failure. scoping:
--
-- 1. challenge_remote gains event_id (backfilled from the joined challenge;
--    the FK cascade on challenge_id guarantees every row has a match).
-- 2. The unique index becomes (event_id, source_key, remote_id): each event
--    owns its own platform-challenge mapping. The same source_key also stops
--    flipping OTHER events' availability in discoverInventory (code-side fix).
CREATE TABLE `challenge_remote_new` (
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
INSERT INTO `challenge_remote_new` (`challenge_id`,`event_id`,`source_key`,`remote_id`,`available`,`solved`,`target_supported`,`target_ignored`,`target_count`,`target_info`,`synced_at`)
SELECT `cr`.`challenge_id`, `c`.`event_id`, `cr`.`source_key`, `cr`.`remote_id`, `cr`.`available`, `cr`.`solved`, `cr`.`target_supported`, `cr`.`target_ignored`, `cr`.`target_count`, `cr`.`target_info`, `cr`.`synced_at`
FROM `challenge_remote` `cr`
INNER JOIN `challenges` `c` ON `c`.`id` = `cr`.`challenge_id`;
--> statement-breakpoint
DROP TABLE `challenge_remote`;
--> statement-breakpoint
ALTER TABLE `challenge_remote_new` RENAME TO `challenge_remote`;
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_remote_source_unique` ON `challenge_remote` (`event_id`,`source_key`,`remote_id`);
