-- One-shot migration: collapse the legacy `agents.prompt` column into
-- the M2 section model. After this script:
--   • agents.system_prompt_main      = old agents.prompt verbatim
--   • agents.system_prompt_tools     = ''  (explicit empty)
--   • agents.system_prompt_subagents = ''  (explicit empty)
--   • agents.prompt                  = NULL (legacy column emptied —
--                                       column itself stays for now;
--                                       drop in a follow-up after the
--                                       code stops referencing it)
--
-- After this runs, every agent has its system prompt expressed in the
-- new structured columns and the `resolveAgentSystemPrompt` legacy
-- branch becomes unreachable.
--
-- Idempotent: only touches rows where prompt is non-null AND
-- system_prompt_main is empty/null (so re-runs don't clobber edits
-- made after the first pass).
--
-- Run with:
--   psql "$DATABASE_URL" -f server/scripts/migrate-prompt-to-main.sql

BEGIN;

UPDATE agents
   SET system_prompt_main      = prompt,
       system_prompt_tools     = '',
       system_prompt_subagents = '',
       prompt                  = NULL,
       updated_at              = NOW()
 WHERE deleted_at IS NULL
   AND prompt IS NOT NULL
   AND prompt <> ''
   AND (system_prompt_main IS NULL OR system_prompt_main = '');

-- Sanity output — how many rows now have:
--   • prompt cleared
--   • a non-empty main override
--   • tools / subagents set to '' explicitly
SELECT 'rows migrated' AS step,
       COUNT(*) AS agents
  FROM agents
 WHERE deleted_at IS NULL
   AND prompt IS NULL
   AND system_prompt_main IS NOT NULL
   AND system_prompt_main <> ''
   AND system_prompt_tools = ''
   AND system_prompt_subagents = '';

SELECT 'rows with leftover prompt (should be 0 after migration)' AS step,
       COUNT(*) AS agents
  FROM agents
 WHERE deleted_at IS NULL
   AND prompt IS NOT NULL
   AND prompt <> '';

COMMIT;
