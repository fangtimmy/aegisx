-- 0011: v17 challenge-scope channels (docs/im-channels.md §十一).
--
-- #team/#announce aggregate from run scope to CHALLENGE scope: one canonical
-- channel per (challenge, kind) survives (min channel id), carrying the merged
-- message history — message ids are globally monotonic, so a plain
-- channel_id UPDATE keeps the cross-channel ordering intact. channel_reads
-- re-point at the canonical channel (agent cursors survive, merged to the
-- max); agent-authored messages in the merged group channels get the
-- `· run-xxxx` authorName suffix (cross-run attribution, looked up from the
-- OLD channel's run before the merge). DM channels (run scope) and the
-- event-scope scheduler DM are copied verbatim.
--
-- The check constraints changed, so `channels` must be recreated — SQLite
-- cannot ALTER a CHECK. The three child tables are recreated alongside (their
-- rows are remapped anyway). Cascade safety: the new child tables reference
-- `channels_new` (NOT `channels`), so dropping the old parent cannot cascade
-- into the copied history; the final RENAMEs rewrite the FK references to
-- the canonical names. sqlite_sequence follows the RENAME (verified), keeping
-- the message-id autoincrement monotonic. Attachment directories on disk
-- (data/channel-files/<channelId>/…) are reconciled by the runtime after the
-- migration (src/db/channel-files.ts).
CREATE TABLE `channels_new` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`run_id` text,
	`event_id` text NOT NULL,
	`challenge_id` text,
	`kind` text NOT NULL,
	`target_agent_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT `channels_scope_type_check` CHECK (`scope_type` in ('run', 'event', 'challenge')),
	CONSTRAINT `channels_kind_check` CHECK (`kind` in ('team', 'announce', 'dm')),
	CONSTRAINT `channels_dm_target_check` CHECK ((`kind` != 'dm') or (`target_agent_id` is not null)),
	CONSTRAINT `channels_scope_run_check` CHECK ((`scope_type` != 'run') or (`run_id` is not null)),
	CONSTRAINT `channels_scope_challenge_check` CHECK (((`scope_type` = 'challenge') and (`challenge_id` is not null) and (`run_id` is null)) or ((`scope_type` != 'challenge') and (`challenge_id` is null))),
	CONSTRAINT `channels_kind_scope_check` CHECK ((((`kind` = 'team') or (`kind` = 'announce')) and (`scope_type` = 'challenge')) or ((`kind` = 'dm') and (`scope_type` != 'challenge'))),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Non-group channels copy verbatim: DMs (run scope) + the scheduler DM (event
-- scope). challenge_id is NULL for both (the new biconditional check).
INSERT INTO `channels_new` (`id`,`scope_type`,`run_id`,`event_id`,`challenge_id`,`kind`,`target_agent_id`,`created_at`)
SELECT `id`,`scope_type`,`run_id`,`event_id`,NULL,`kind`,`target_agent_id`,`created_at` FROM `channels`
WHERE `scope_type` != 'run' OR `kind` = 'dm';
--> statement-breakpoint
-- Canonical group channel per (challenge, kind) = min channel id; it is
-- re-scoped to the challenge (run_id dropped, challenge_id stamped).
INSERT INTO `channels_new` (`id`,`scope_type`,`run_id`,`event_id`,`challenge_id`,`kind`,`target_agent_id`,`created_at`)
SELECT `c`.`id`,'challenge',NULL,`c`.`event_id`,`r`.`challenge_id`,`c`.`kind`,NULL,`c`.`created_at`
FROM `channels` `c`
JOIN `runs` `r` ON `r`.`id` = `c`.`run_id`
WHERE `c`.`scope_type` = 'run' AND `c`.`kind` in ('team','announce')
	AND `c`.`id` = (
		SELECT min(`c2`.`id`) FROM `channels` `c2`
		JOIN `runs` `r2` ON `r2`.`id` = `c2`.`run_id`
		WHERE `c2`.`scope_type` = 'run' AND `c2`.`kind` = `c`.`kind` AND `r2`.`challenge_id` = `r`.`challenge_id`
	);
--> statement-breakpoint
CREATE TABLE `channel_messages_new` (
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
	FOREIGN KEY (`channel_id`) REFERENCES `channels_new`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Messages: group-channel rows re-point at the canonical channel; agent posts
-- from the (soon gone) run-scoped group channels get the run-suffix snapshot.
-- DM + scheduler-DM rows are copied verbatim (LEFT JOIN — their run is NULL).
INSERT INTO `channel_messages_new` (`id`,`channel_id`,`kind`,`author_type`,`author_agent_id`,`author_name`,`body`,`meta`,`created_at`)
SELECT `m`.`id`,
	CASE WHEN `c`.`scope_type` = 'run' AND `c`.`kind` in ('team','announce')
		THEN (SELECT min(`c2`.`id`) FROM `channels` `c2`
			JOIN `runs` `r2` ON `r2`.`id` = `c2`.`run_id`
			WHERE `c2`.`scope_type` = 'run' AND `c2`.`kind` = `c`.`kind` AND `r2`.`challenge_id` = `r`.`challenge_id`)
		ELSE `m`.`channel_id` END,
	`m`.`kind`,`m`.`author_type`,`m`.`author_agent_id`,
	CASE WHEN `m`.`author_type` = 'agent' AND `c`.`scope_type` = 'run' AND `c`.`kind` in ('team','announce')
		THEN `m`.`author_name` || ' · run-' || substr(`c`.`run_id`, 1, 4)
		ELSE `m`.`author_name` END,
	`m`.`body`,`m`.`meta`,`m`.`created_at`
FROM `channel_messages` `m`
JOIN `channels` `c` ON `c`.`id` = `m`.`channel_id`
LEFT JOIN `runs` `r` ON `r`.`id` = `c`.`run_id`;
--> statement-breakpoint
CREATE TABLE `channel_reads_new` (
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`last_read_msg_id` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`channel_id`,`agent_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels_new`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Read cursors re-point at the mapped channel; an agent holding cursors in
-- several merged channels collapses to the MAX (history agent cursors
-- survive, §11.6).
INSERT INTO `channel_reads_new` (`channel_id`,`agent_id`,`last_read_msg_id`,`updated_at`)
SELECT
	CASE WHEN `c`.`scope_type` = 'run' AND `c`.`kind` in ('team','announce')
		THEN (SELECT min(`c2`.`id`) FROM `channels` `c2`
			JOIN `runs` `r2` ON `r2`.`id` = `c2`.`run_id`
			WHERE `c2`.`scope_type` = 'run' AND `c2`.`kind` = `c`.`kind` AND `r2`.`challenge_id` = `r`.`challenge_id`)
		ELSE `cr`.`channel_id` END,
	`cr`.`agent_id`, max(`cr`.`last_read_msg_id`), max(`cr`.`updated_at`)
FROM `channel_reads` `cr`
JOIN `channels` `c` ON `c`.`id` = `cr`.`channel_id`
LEFT JOIN `runs` `r` ON `r`.`id` = `c`.`run_id`
GROUP BY 1, `cr`.`agent_id`;
--> statement-breakpoint
CREATE TABLE `channel_files_new` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `channel_messages_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels_new`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `channel_files_new` (`id`,`message_id`,`channel_id`,`filename`,`size`,`created_at`)
SELECT `f`.`id`,`f`.`message_id`,
	CASE WHEN `c`.`scope_type` = 'run' AND `c`.`kind` in ('team','announce')
		THEN (SELECT min(`c2`.`id`) FROM `channels` `c2`
			JOIN `runs` `r2` ON `r2`.`id` = `c2`.`run_id`
			WHERE `c2`.`scope_type` = 'run' AND `c2`.`kind` = `c`.`kind` AND `r2`.`challenge_id` = `r`.`challenge_id`)
		ELSE `f`.`channel_id` END,
	`f`.`filename`,`f`.`size`,`f`.`created_at`
FROM `channel_files` `f`
JOIN `channels` `c` ON `c`.`id` = `f`.`channel_id`
LEFT JOIN `runs` `r` ON `r`.`id` = `c`.`run_id`;
--> statement-breakpoint
DROP TABLE `channel_files`;
--> statement-breakpoint
DROP TABLE `channel_reads`;
--> statement-breakpoint
DROP TABLE `channel_messages`;
--> statement-breakpoint
DROP TABLE `channels`;
--> statement-breakpoint
ALTER TABLE `channels_new` RENAME TO `channels`;
--> statement-breakpoint
ALTER TABLE `channel_messages_new` RENAME TO `channel_messages`;
--> statement-breakpoint
ALTER TABLE `channel_reads_new` RENAME TO `channel_reads`;
--> statement-breakpoint
ALTER TABLE `channel_files_new` RENAME TO `channel_files`;
--> statement-breakpoint
CREATE INDEX `channels_run_id_idx` ON `channels` (`run_id`);
--> statement-breakpoint
CREATE INDEX `channels_event_id_idx` ON `channels` (`event_id`);
--> statement-breakpoint
CREATE INDEX `channels_challenge_id_idx` ON `channels` (`challenge_id`);
--> statement-breakpoint
CREATE INDEX `channel_messages_channel_id_idx` ON `channel_messages` (`channel_id`,`id`);
--> statement-breakpoint
CREATE INDEX `channel_files_message_id_idx` ON `channel_files` (`message_id`);
