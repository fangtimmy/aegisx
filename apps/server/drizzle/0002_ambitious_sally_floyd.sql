CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_model_id` text,
	`environment` text DEFAULT 'local' NOT NULL,
	`container_image` text DEFAULT 'alpine:3.22' NOT NULL,
	`cpu_limit` integer DEFAULT 1000 NOT NULL,
	`memory_mb` integer DEFAULT 512 NOT NULL,
	`pids_limit` integer DEFAULT 128 NOT NULL,
	`max_concurrency` integer DEFAULT 2 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "settings_singleton_check" CHECK("settings"."id" = 1),
	CONSTRAINT "settings_environment_check" CHECK("settings"."environment" in ('local', 'container'))
);
--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "provider_connections_type_check" CHECK("provider_connections"."type" in ('openai-compatible', 'openai-responses', 'anthropic-messages'))
);
--> statement-breakpoint
CREATE TABLE `provider_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`label` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_models_provider_id_idx` ON `provider_models` (`provider_id`);
--> statement-breakpoint
CREATE INDEX `provider_models_provider_model_idx` ON `provider_models` (`provider_id`,`model_id`);
