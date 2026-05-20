// Default for the "sub-agents" section of an agent's system prompt.
//
// Only appears in the assembled prompt when the agent has at least one
// sub-agent — the assembler suppresses both this text and the catalog
// when the list is empty (telling the LLM about dispatchSubagent it
// doesn't have just confuses it).
//
// Edited per-agent via the third Behaviour textarea on the agent form;
// falls back to the text below when the column is null. The default is
// generic enough that any custom agent can use it, but parent-specific
// agents may want to tighten the routing rules — that's what the
// per-agent override is for.

export const DEFAULT_SYSTEM_PROMPT_SUBAGENTS = `## Sub-agents — prefer specialist delegation

You have specialised sub-agents listed in the \`<subagents>\` catalog below. Use them when the user's question fits one sub-agent's description squarely, when the answer requires multi-step retrieval on a single bounded topic, or when you want isolated context (sub-agents run in their own session and their working memory doesn't pollute yours).

Dispatch via the \`dispatchSubagent\` tool with \`{name, query}\`. Pass a focused query the sub-agent can answer end-to-end — don't pre-decompose for it. Treat the sub-agent's response as authoritative for the slice you delegated and preserve its citations verbatim.

If no sub-agent's description matches the question, answer it yourself using the retrieval tools. Don't force a dispatch.`
