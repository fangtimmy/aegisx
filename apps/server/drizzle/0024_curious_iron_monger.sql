CREATE TABLE `platform_request_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_headers` text NOT NULL,
	`request_body` text,
	`status` integer,
	`response_headers` text,
	`response_body` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `platform_request_log_created_at_idx` ON `platform_request_log` (`created_at`);