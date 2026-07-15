CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider_type` text DEFAULT 'builtin' NOT NULL,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`model_id` text DEFAULT 'claude-sonnet-4-5' NOT NULL,
	`base_url` text,
	`api_key` text,
	`environment` text DEFAULT 'local' NOT NULL,
	`container_image` text DEFAULT 'alpine:3.22' NOT NULL,
	`cpu_limit` integer DEFAULT 1000 NOT NULL,
	`memory_mb` integer DEFAULT 512 NOT NULL,
	`pids_limit` integer DEFAULT 128 NOT NULL,
	`max_concurrency` integer DEFAULT 2 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "settings_singleton_check" CHECK("settings"."id" = 1),
	CONSTRAINT "settings_provider_type_check" CHECK("settings"."provider_type" in ('builtin', 'openai-compatible')),
	CONSTRAINT "settings_environment_check" CHECK("settings"."environment" in ('local', 'container'))
);
