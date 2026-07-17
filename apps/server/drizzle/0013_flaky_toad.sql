ALTER TABLE `runs` ADD `prompt_config` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `system_prompt_template` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `initial_prompt_template` text DEFAULT '' NOT NULL;