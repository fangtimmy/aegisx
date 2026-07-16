ALTER TABLE `challenges` ADD `remote_target_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `challenges` SET `remote_target_count` = 1 WHERE `remote_target` = true;
