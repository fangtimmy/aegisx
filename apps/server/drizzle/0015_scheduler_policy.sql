-- 0015: per-event scheduler orchestration policy (scheduler_config columns).
--
-- Read side coalesces in run/scheduler-policy.ts; the DB defaults are also
-- the insert fallback for legacy create paths (setSchedulerPaused insert
-- branch). Additive only — existing rows keep current behavior:
-- notify/stop-siblings/stop-target/urgent-team default on, next-task-policy
-- 'eager' (a solved challenge frees its target slot at flag acceptance).
ALTER TABLE `scheduler_config` ADD `notify_team_on_flag` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduler_config` ADD `stop_siblings_on_solve` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduler_config` ADD `stop_target_on_solve` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduler_config` ADD `next_task_policy` text DEFAULT 'eager' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduler_config` ADD `urgent_team_messages` integer DEFAULT true NOT NULL;
