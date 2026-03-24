## Detailed Comparison: pi-mono/tools vs tools

This document compares each tool in `pi-mono/tools` with the closest corresponding tool (if any) in `tools`. For each tool in `pi-mono/tools`, we note if there is a direct or similar file in `tools`, and summarize the difference in purpose, naming, or structure.

---

### ask-for-clarification.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** This tool is unique to `pi-mono/tools`.

---

### fall-back.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** This tool is unique to `pi-mono/tools`.

---

### get-slack-related-messages.ts
- **pi-mono/tools:** Present
- **tools:** Closest: `slack/getSlackMessages.ts`
- **Diff:** Both relate to Slack message retrieval, but file naming and possibly implementation differ. `pi-mono` uses a flat structure, `tools` uses a subfolder.

---

### index.ts
- **pi-mono/tools:** Present
- **tools:** Present
- **Diff:** Both have an index file, but their exports and structure may differ due to different tool sets.

---

### list-custom-agents.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** Unique to `pi-mono/tools`.

---

### ls-knowledge-base.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** Unique to `pi-mono/tools`.

---

### run-public-agent.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** Unique to `pi-mono/tools`.

---

### search-calendar-events.ts
- **pi-mono/tools:** Present
- **tools:** Closest: `google/calendar.ts`
- **Diff:** Both relate to calendar events, but `pi-mono` uses a flat file, `tools` uses a subfolder for Google integrations.

---

### search-chat-history.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** Unique to `pi-mono/tools`.

---

### search-drive-files.ts
- **pi-mono/tools:** Present
- **tools:** Closest: `google/drive.ts`
- **Diff:** Both relate to Google Drive file search, but structure and naming differ.

---

### search-global.ts
- **pi-mono/tools:** Present
- **tools:** Possibly related: `global/index.ts`
- **Diff:** `pi-mono` has a specific tool, `tools` has a global folder, but not a direct match.

---

### search-gmail.ts
- **pi-mono/tools:** Present
- **tools:** Closest: `google/gmail.ts`
- **Diff:** Both relate to Gmail, but structure and naming differ.

---

### search-google-contacts.ts
- **pi-mono/tools:** Present
- **tools:** Closest: `google/contacts.ts`
- **Diff:** Both relate to Google Contacts, but structure and naming differ.

---

### search-knowledge-base.ts
- **pi-mono/tools:** Present
- **tools:** Possibly related: `knowledgeBaseFlow.ts`
- **Diff:** Both may relate to knowledge base operations, but implementation and structure differ.

---

### synthesize-final-answer.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** Unique to `pi-mono/tools`.

---

### to-do-write.ts
- **pi-mono/tools:** Present
- **tools:** No direct equivalent
- **Diff:** Unique to `pi-mono/tools`.

---

### Additional files in tools only
- `chatMemory.ts`, `schemas.ts`, `types.ts`, `utils.ts`, and the subfolders `global/`, `google/`, `slack/` (except for the files mapped above) have no direct equivalents in `pi-mono/tools`.

---

## Summary Table

| pi-mono/tools file         | Closest tools match         | Notes/Diff |
|---------------------------|-----------------------------|------------|
| ask-for-clarification.ts  | (none)                      | Unique to pi-mono |
| fall-back.ts              | (none)                      | Unique to pi-mono |
| get-slack-related-messages.ts | slack/getSlackMessages.ts | Naming/structure differ |
| index.ts                  | index.ts                    | Both present, exports differ |
| list-custom-agents.ts     | (none)                      | Unique to pi-mono |
| ls-knowledge-base.ts      | (none)                      | Unique to pi-mono |
| run-public-agent.ts       | (none)                      | Unique to pi-mono |
| search-calendar-events.ts | google/calendar.ts          | Naming/structure differ |
| search-chat-history.ts    | (none)                      | Unique to pi-mono |
| search-drive-files.ts     | google/drive.ts             | Naming/structure differ |
| search-global.ts          | global/index.ts?            | Not a direct match |
| search-gmail.ts           | google/gmail.ts             | Naming/structure differ |
| search-google-contacts.ts | google/contacts.ts          | Naming/structure differ |
| search-knowledge-base.ts  | knowledgeBaseFlow.ts?       | Not a direct match |
| synthesize-final-answer.ts| (none)                      | Unique to pi-mono |
| to-do-write.ts            | (none)                      | Unique to pi-mono |