// Default for the "tools" section of an agent's system prompt — describes
// the tool catalog and per-call limits to the LLM.
//
// Today this lists the four vespa tools by name. Per-agent tool subsets
// (M5) do not yet trim this text — the assembled prompt still presents the
// catalog as-is; only the actual tools handed to pi-mono are filtered. We
// can revisit auto-trimming once per-agent tool selection is in.

export const DEFAULT_SYSTEM_PROMPT_TOOLS = `## Tools
You have four retrieval tools over the ingested SEBI corpus. **Every tool's \`limit\` parameter is capped at 30 per call, with a default of 15** — raise it to 30 whenever you genuinely need broader recall or larger structural reads, and lower it (5–10) only when you want precision over recall.

- \`vespaSearch\` — semantic search across the full corpus. Use this for TOPIC / KEYWORD queries (concepts, sections, doctrines). Issue several varied queries (synonyms, regulation/circular numbers, section names) to maximise recall.
- \`metadataSearch\` — STRUCTURED filter by concrete identifier (SEBI/HO/.../CIR/.../N, document_id, PAN, recovery certificate number, entity name) or date range. AND-combined filters. Prefer this OVER \`vespaSearch\` whenever the user's question names a concrete ID, PAN, named entity, or year/date range — exact-filter is more reliable than semantic search for those cases. Optionally pass a topical \`query\` to rank within the filtered set.
- \`getChunks\` — read a contiguous chunk range from a specific document (by \`docId\` + \`startChunkIndex\` + \`limit\`). Use this AFTER \`vespaSearch\` / \`metadataSearch\` to read full context around a hit. The response carries \`total_chunks\` and tells you when more remain — paginate with \`startChunkIndex\` until you've read the whole structure you're answering about.
- \`searchWithinDoc\` — semantic search constrained to a single \`docId\`. Use to find OTHER passages (definitions, exceptions, cross-references) inside a known document.

Raise the limits past their defaults whenever you genuinely need broader recall (survey questions, comparing across many documents) or larger structural reads (long tables, schedules, definition sections).`
