-- v11: add agents.tool_definitions (active tool-definition snapshots).
--
-- A single nullable TEXT column holding a JSON array of the agent's active
-- tool definitions ({ name, description, parameters (JSON Schema),
-- promptGuidelines? }), written when the host session is created
-- (prepareAgent). Lets the timeline render real tool schemas incl. the
-- always-on file tools (read/bash/edit/write) that were never persisted
-- before. Additive ALTER TABLE; null on pre-v11 rows / agents never brought
-- online, which the frontend tolerates (renders the name-only fallback).
ALTER TABLE `agents` ADD COLUMN `tool_definitions` text;
