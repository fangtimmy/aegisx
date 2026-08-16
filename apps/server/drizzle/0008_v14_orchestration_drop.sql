-- 0008: v9 orchestration simplification (schema v14).
--
-- The orchestration plugin layer is being removed (v9): scopeType alone
-- distinguishes the two run kinds (challenge solver runs / the event
-- scheduler run), so runs.orchestration and run_queue.orchestration go away.
-- Execution state is wiped (v8 precedent): old plugin agent rows / spawn
-- children cannot be mapped onto the new direct-creation model. Catalog
-- tables (events / challenges / attachments / challenge_flags),
-- scheduler_config, queue_state and prompt_templates survive; plugin-owned
-- template rows (and the now-dead childSystem key) are pruned.
DROP INDEX IF EXISTS runs_orchestration_idx;
--> statement-breakpoint
DELETE FROM session_entries;
--> statement-breakpoint
DELETE FROM sessions;
--> statement-breakpoint
DELETE FROM agents;
--> statement-breakpoint
DELETE FROM runs;
--> statement-breakpoint
DELETE FROM run_queue;
--> statement-breakpoint
DELETE FROM prompt_templates WHERE plugin != 'builtin' OR key = 'childSystem';
--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `orchestration`;
--> statement-breakpoint
ALTER TABLE `run_queue` DROP COLUMN `orchestration`;
