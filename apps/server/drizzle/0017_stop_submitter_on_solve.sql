-- 0017: evaluation-mode solve cleanup. On (default off) a FULL solve
-- terminates the submitting agent immediately instead of leaving it a
-- write-up wrap-up window (benchmark platforms only score flags).
ALTER TABLE `scheduler_config` ADD `stop_submitter_on_solve` integer DEFAULT false NOT NULL;
