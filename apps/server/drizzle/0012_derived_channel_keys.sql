-- 0012: v18 derived channel keys (docs/im-simplify-v18.md §7.1).
--
-- The `channels` directory table is dropped: a channel is a DERIVED KEY
-- ("team:<challengeId>" | "dm:<agentId>" | "orch:<eventId>") stored directly
-- on the message rows. Key mapping from the v17 shapes:
--   challenge-scope team     → "team:<challengeId>"
--   challenge-scope announce → "team:<challengeId>"   (#announce merges into
--     #team — message ids are globally monotonic, so a plain key UPDATE keeps
--     the merged order intact; same technique as 0011's channel merge)
--   run-scope dm             → "dm:<targetAgentId>"
--   event-scope dm           → "orch:<eventId>"       (the scheduler channel)
-- recap rows (kind='recap' digest snapshots) are deleted along with the
-- digest mechanism. channel_reads re-keys (channelId → derived key; the
-- scheduler reader row keeps reader_key='scheduler'); a reader holding
-- cursors on both #team and #announce of one challenge collapses to MAX.
-- channel_files loses its channel_id column; the on-disk directories
-- (data/channel-files/<channelId>/<messageId>/) are flattened to
-- data/channel-files/<messageId>/ by the runtime reconcile after migration
-- (src/db/channel-files.ts) — message ids are unique so the move is safe.
-- History is preserved (NOT a wipe): #team is the same-challenge knowledge
-- base, the whole point of keeping it.
CREATE TABLE `channel_messages_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_key` text NOT NULL,
	`author_type` text NOT NULL,
	`author_agent_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `channel_messages_author_type_check` CHECK (`author_type` in ('system', 'user', 'agent'))
);
--> statement-breakpoint
INSERT INTO `channel_messages_new` (`id`,`channel_key`,`author_type`,`author_agent_id`,`author_name`,`body`,`meta`,`created_at`)
SELECT `m`.`id`,
	CASE
		WHEN `c`.`scope_type` = 'challenge' AND `c`.`kind` in ('team','announce')
			THEN 'team:' || `c`.`challenge_id`
		WHEN `c`.`scope_type` = 'run' AND `c`.`kind` = 'dm'
			THEN 'dm:' || `c`.`target_agent_id`
		WHEN `c`.`scope_type` = 'event' AND `c`.`kind` = 'dm'
			THEN 'orch:' || `c`.`event_id`
	END,
	`m`.`author_type`,`m`.`author_agent_id`,`m`.`author_name`,`m`.`body`,`m`.`meta`,`m`.`created_at`
FROM `channel_messages` `m`
JOIN `channels` `c` ON `c`.`id` = `m`.`channel_id`
WHERE `m`.`kind` != 'recap';
--> statement-breakpoint
CREATE TABLE `channel_reads_new` (
	`channel_key` text NOT NULL,
	`reader_key` text NOT NULL,
	`last_read_msg_id` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`channel_key`,`reader_key`)
);
--> statement-breakpoint
-- Reader cursors re-key onto the derived key; a reader holding cursors in
-- both #team and #announce of one challenge collapses to MAX (announce was
-- scheduler FYI — max never re-delivers already-read team history; an
-- unseen announce tail may be skipped, accepted).
INSERT INTO `channel_reads_new` (`channel_key`,`reader_key`,`last_read_msg_id`,`updated_at`)
SELECT
	CASE
		WHEN `c`.`scope_type` = 'challenge' AND `c`.`kind` in ('team','announce')
			THEN 'team:' || `c`.`challenge_id`
		WHEN `c`.`scope_type` = 'run' AND `c`.`kind` = 'dm'
			THEN 'dm:' || `c`.`target_agent_id`
		WHEN `c`.`scope_type` = 'event' AND `c`.`kind` = 'dm'
			THEN 'orch:' || `c`.`event_id`
	END,
	`cr`.`agent_id`, max(`cr`.`last_read_msg_id`), max(`cr`.`updated_at`)
FROM `channel_reads` `cr`
JOIN `channels` `c` ON `c`.`id` = `cr`.`channel_id`
GROUP BY 1, `cr`.`agent_id`;
--> statement-breakpoint
CREATE TABLE `channel_files_new` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `channel_messages_new`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `channel_files_new` (`id`,`message_id`,`filename`,`size`,`created_at`)
SELECT `f`.`id`,`f`.`message_id`,`f`.`filename`,`f`.`size`,`f`.`created_at`
FROM `channel_files` `f`
JOIN `channel_messages` `m` ON `m`.`id` = `f`.`message_id`
WHERE `m`.`kind` != 'recap';
--> statement-breakpoint
DROP TABLE `channel_files`;
--> statement-breakpoint
DROP TABLE `channel_reads`;
--> statement-breakpoint
DROP TABLE `channel_messages`;
--> statement-breakpoint
DROP TABLE `channels`;
--> statement-breakpoint
ALTER TABLE `channel_messages_new` RENAME TO `channel_messages`;
--> statement-breakpoint
ALTER TABLE `channel_reads_new` RENAME TO `channel_reads`;
--> statement-breakpoint
ALTER TABLE `channel_files_new` RENAME TO `channel_files`;
--> statement-breakpoint
CREATE INDEX `channel_messages_channel_key_idx` ON `channel_messages` (`channel_key`,`id`);
--> statement-breakpoint
CREATE INDEX `channel_files_message_id_idx` ON `channel_files` (`message_id`);
