ALTER TABLE `provider_models` ADD `pi_provider_id` text;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `pi_model_id` text;--> statement-breakpoint
UPDATE `provider_models`
SET `metadata` = json_object(
  'reasoning', CASE WHEN `reasoning` THEN json('true') ELSE json('false') END,
  'thinkingLevelMap', json(`thinking_level_map`),
  'input', json('["text"]'),
  'cost', json('{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}'),
  'costKnown', json('false'),
  'contextWindow', 128000,
  'maxTokens', 16384
)
WHERE `metadata` = '{}';--> statement-breakpoint
ALTER TABLE `provider_models` DROP COLUMN `reasoning`;--> statement-breakpoint
ALTER TABLE `provider_models` DROP COLUMN `thinking_level_map`;
