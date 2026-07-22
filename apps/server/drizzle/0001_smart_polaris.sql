PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`status` text DEFAULT 'succeeded' NOT NULL,
	`timeout_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`output_bytes` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`succeeded` integer DEFAULT false NOT NULL,
	`exit_code` integer,
	`error` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agent_tool_calls`("id", "agent_id", "tool_call_id", "tool_name", "status", "timeout_ms", "duration_ms", "output_bytes", "truncated", "succeeded", "exit_code", "error", "created_at", "completed_at") SELECT "id", "agent_id", "tool_call_id", "tool_name", 'succeeded', 0, "duration_ms", "output_bytes", "truncated", "succeeded", "exit_code", NULL, "created_at", "created_at" FROM `agent_tool_calls`;--> statement-breakpoint
DROP TABLE `agent_tool_calls`;--> statement-breakpoint
ALTER TABLE `__new_agent_tool_calls` RENAME TO `agent_tool_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_tool_calls_agent_id_idx` ON `agent_tool_calls` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_tool_calls_agent_created_at_idx` ON `agent_tool_calls` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tool_calls_agent_tool_call_unique` ON `agent_tool_calls` (`agent_id`,`tool_call_id`);
