CREATE TABLE `agent_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`output_bytes` integer NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`succeeded` integer NOT NULL,
	`exit_code` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `run_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tool_calls_agent_id_idx` ON `agent_tool_calls` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_tool_calls_agent_created_at_idx` ON `agent_tool_calls` (`agent_id`,`created_at`);