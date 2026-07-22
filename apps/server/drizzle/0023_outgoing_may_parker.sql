PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_model_id` text,
	`default_thinking_level` text DEFAULT 'off' NOT NULL,
	`environment` text DEFAULT 'local' NOT NULL,
	`container_image` text DEFAULT 'alpine:3.22' NOT NULL,
	`cpu_limit` integer DEFAULT 2000 NOT NULL,
	`memory_mb` integer DEFAULT 2048 NOT NULL,
	`pids_limit` integer DEFAULT 256 NOT NULL,
	`max_concurrency` integer DEFAULT 2 NOT NULL,
	`max_attachment_mb` integer DEFAULT 512 NOT NULL,
	`system_prompt_template` text DEFAULT '' NOT NULL,
	`child_system_prompt_template` text DEFAULT '' NOT NULL,
	`initial_prompt_template` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_model_id`) REFERENCES `provider_models`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settings_singleton_check" CHECK("id" = 1),
	CONSTRAINT "settings_environment_check" CHECK("environment" in ('local', 'container'))
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "default_model_id", "default_thinking_level", "environment", "container_image", "cpu_limit", "memory_mb", "pids_limit", "max_concurrency", "max_attachment_mb", "system_prompt_template", "child_system_prompt_template", "initial_prompt_template", "updated_at") SELECT "id", "default_model_id", "default_thinking_level", "environment", "container_image", "cpu_limit", "memory_mb", "pids_limit", "max_concurrency", "max_attachment_mb", "system_prompt_template", "child_system_prompt_template", "initial_prompt_template", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;