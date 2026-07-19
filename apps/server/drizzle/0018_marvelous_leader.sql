PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`flag` text NOT NULL,
	`status` text NOT NULL,
	`remote_id` text,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "submissions_status_check" CHECK(status in ('pending', 'accepted', 'rejected', 'partial', 'already_solved', 'rate_limited', 'error'))
);
--> statement-breakpoint
INSERT INTO `__new_submissions`("id", "run_id", "flag", "status", "remote_id", "message", "created_at", "updated_at") SELECT "id", "run_id", "flag", "status", "remote_id", "message", "created_at", "updated_at" FROM `submissions`;--> statement-breakpoint
DROP TABLE `submissions`;--> statement-breakpoint
ALTER TABLE `__new_submissions` RENAME TO `submissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `submissions_run_id_idx` ON `submissions` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_run_flag_unique` ON `submissions` (`run_id`,`flag`);--> statement-breakpoint
DROP INDEX `provider_models_provider_model_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_models_provider_model_unique` ON `provider_models` (`provider_id`,`model_id`);
