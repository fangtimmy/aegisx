-- 0018: partial unique index on agents.token. agent-auth resolves the agent
-- principal from the bearer token on every tokenized request — previously a
-- full table scan. Partial: the column default '' must stay non-unique
-- (historical rows); spawn always writes a real token.
CREATE UNIQUE INDEX `agents_token_unique` ON `agents` (`token`) WHERE `agents`.`token` != '';
