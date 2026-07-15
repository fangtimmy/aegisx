ALTER TABLE `runs` ADD `prompt` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_config` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `environment_config` text DEFAULT '{"type":"local"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `session_path` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `workspace_path` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `error` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `flag` text;