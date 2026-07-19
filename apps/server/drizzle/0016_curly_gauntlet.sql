ALTER TABLE `provider_models` ADD `reasoning` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `thinking_level_map` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `metadata` text DEFAULT '{}' NOT NULL;
