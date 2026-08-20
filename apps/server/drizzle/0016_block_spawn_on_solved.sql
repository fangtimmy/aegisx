-- 0016: solved-challenge spawn gate. While on (default), the fence rejects
-- spawns on a fully-solved challenge (accepted flag / remote solved / manual
-- solved) and the queue drainer cancels its pending items. Off = deliberate
-- re-attack (reproduction / writeup agents).
ALTER TABLE `scheduler_config` ADD `block_spawn_on_solved` integer DEFAULT true NOT NULL;
