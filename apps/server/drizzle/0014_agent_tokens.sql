-- 0014: agent identity tokens (docs/sdk-refactor.md W1).
--
-- Every agent row carries an opaque token; spawn injects it per-exec as
-- AEGISX_TOKEN next to AEGISX_AGENT_ID, the SDK sends it as a Bearer header,
-- and the server derives the principal (id / eventId / role) from it — the
-- self-reported X-Aegisx-Agent-Id header and the client-side `source` field
-- are gone. Existing rows get random backfill (they are historical; their
-- containers are gone, the tokens are simply never presented).
ALTER TABLE `agents` ADD `token` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `agents` SET `token` = lower(hex(randomblob(32))) WHERE `token` = '';
