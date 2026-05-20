-- One-shot backfill: fill agents.tools with the full pi-mono registry
-- list for any row that still has the empty-array default.
--
-- Context: M3 added agents.tools jsonb DEFAULT '[]' and M4a wires the
-- runner so an empty array means "all tools available" (the back-compat
-- path that lets existing agents pick up any future tool added to the
-- registry). That semantic is preserved in the runtime. But the M6 view
-- pages render an empty list as a bare "All tools" pill with no per-tool
-- detail. Filling the column with concrete names makes the view show
-- explicit tool tiles for every pre-existing agent.
--
-- Idempotent: rows that already opted into a subset (tools.length > 0)
-- are skipped. Sub-agents are NOT touched — their own `tools` column
-- keeps the "[] = all" semantic until an editor picks a subset.
--
-- Run with:
--   psql "$DATABASE_URL" -f server/scripts/backfill-agent-tools.sql
--
-- The tool name list below MUST stay in lock-step with TOOL_REGISTRY in
-- server/backendv2/agent/pi-mono/tools/registry.ts. Adding a new tool
-- to the registry does not require re-running this script — empty-row
-- agents are gone after the first run, and tools added later are
-- automatically available to those agents through the explicit list.

BEGIN;

UPDATE agents
   SET tools = '["vespaSearch","metadataSearch","getChunks","searchWithinDoc"]'::jsonb,
       updated_at = NOW()
 WHERE deleted_at IS NULL
   AND jsonb_typeof(tools) = 'array'
   AND jsonb_array_length(tools) = 0;

-- Sanity output — how many rows now carry the full registry vs leftovers
-- still empty (shouldn't be any) vs already-customised.
SELECT
  CASE
    WHEN jsonb_array_length(tools) = 0 THEN 'empty (unexpected)'
    WHEN tools @> '["vespaSearch","metadataSearch","getChunks","searchWithinDoc"]'::jsonb
      AND jsonb_array_length(tools) = 4 THEN 'full registry'
    ELSE 'custom subset'
  END                                                        AS state,
  COUNT(*)                                                   AS agents
FROM agents
WHERE deleted_at IS NULL
GROUP BY 1
ORDER BY 1;

COMMIT;
