-- One-shot cleanup: clear per-agent overrides for the Tools and
-- Sub-agents sections, enable the full tool registry, and remove all
-- sub-agent rows. After this every custom (and default) agent uses the
-- workspace default for both sections, has access to every registered
-- tool, and has zero sub-agents. The legacy `prompt` column and the
-- new `system_prompt_main` override are deliberately NOT touched —
-- those carry the agent's identity / persona and stay as-is.
--
-- Idempotent: re-running is safe (NULL is the new state for the two
-- section columns; soft-deleted sub-agents stay soft-deleted; tools
-- already at the full registry are no-op'd).
--
-- Run with:
--   psql "$DATABASE_URL" -f server/scripts/reset-custom-agent-overrides.sql

BEGIN;

-- 1) Custom (non-default) agents: explicit empty tools section + null
--    sub-agents section. Both produce the same runtime behaviour (the
--    resolveAgentSystemPrompt falls to the legacy `prompt` path when
--    no section override is non-empty), but a literal '' on the tools
--    column documents "this agent deliberately has no extra tools
--    prose" — vs NULL which we'd interpret as "use the workspace
--    default" elsewhere. The agent's legacy `prompt` column already
--    covers tool usage in-line, so a separate tools section would be
--    duplicative noise.
UPDATE agents
   SET system_prompt_tools = '',
       system_prompt_subagents = NULL,
       updated_at = NOW()
 WHERE deleted_at IS NULL
   AND is_default = false;

-- 1b) The workspace default ("General agent") row: clear every section
--    override so it tracks the workspace defaults from now on. Phantom
--    overrides (textareas pre-filled with the default at edit time and
--    saved unchanged) get reset here.
UPDATE agents
   SET system_prompt_main = NULL,
       system_prompt_tools = NULL,
       system_prompt_subagents = NULL,
       updated_at = NOW()
 WHERE deleted_at IS NULL
   AND is_default = true;

-- 2) Enable every registered tool on every agent (re-runs the
--    backfill semantic for any row still at the empty-array default).
--    The tool-name list must stay in lock-step with TOOL_REGISTRY in
--    server/backendv2/agent/pi-mono/tools/registry.ts.
UPDATE agents
   SET tools = '["vespaSearch","metadataSearch","getChunks","searchWithinDoc"]'::jsonb,
       updated_at = NOW()
 WHERE deleted_at IS NULL
   AND (
        jsonb_typeof(tools) <> 'array'
     OR jsonb_array_length(tools) = 0
     OR NOT (tools @> '["vespaSearch","metadataSearch","getChunks","searchWithinDoc"]'::jsonb)
   );

-- 3) Hard-delete every sub-agent row (live and soft-deleted). No
--    back-compat concern: the v2_chat_runs `sub_agent_id` column is
--    plain text without an FK, so historical run traces keep their
--    sub-agent external_id as a free-text label after delete.
DELETE FROM sub_agents;

-- Sanity output: counts after cleanup.
SELECT 'agents — section overrides cleared'                AS step,
       COUNT(*)                                            AS agents_with_no_section_overrides
  FROM agents
 WHERE deleted_at IS NULL
   AND system_prompt_tools IS NULL
   AND system_prompt_subagents IS NULL;

SELECT 'agents — full tool registry'                       AS step,
       COUNT(*)                                            AS agents
  FROM agents
 WHERE deleted_at IS NULL
   AND tools @> '["vespaSearch","metadataSearch","getChunks","searchWithinDoc"]'::jsonb
   AND jsonb_array_length(tools) = 4;

SELECT 'sub_agents — rows left in table'                   AS step,
       COUNT(*)                                            AS rows
  FROM sub_agents;

COMMIT;
