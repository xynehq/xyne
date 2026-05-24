// getFolderTree — list the collection→folder tree from Postgres so the agent
// can pick a folder scope before searching.
//
// vespaSearch's `folder` param wants a path that matches the Vespa `fileName`
// field (e.g. "Enforcements/Orders/Orders of AO"). The agent can't guess those
// paths, so this tool surfaces them straight from the knowledge_base tables.
// It returns one line per folder, already prefixed with the collection name,
// ready to be pasted into vespaSearch / metadataSearch.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { and, eq, isNull } from "drizzle-orm"

import { db } from "@/db/client"
import { collections, collectionItems } from "@/db/schema/knowledgeBase"

import type { AgentScope } from "../../../agent-scope"
import type { Log } from "../../../log"
import { textResult } from "./util"

const DEFAULT_MAX_DEPTH = 3

const DESCRIPTION = [
  "List the collection → folder tree for the knowledge base. Use this BEFORE ",
  "a scoped search when the user names a folder/section (e.g. 'orders in ",
  "Enforcements') so you can pick the exact `folder` path to pass to ",
  "`vespaSearch` or `metadataSearch`. Each line is a ready-to-use path of the ",
  "form `<Collection>/<sub>/<folder>` that matches the document `fileName`. ",
  "If you already know the folder path, skip this and search directly.",
].join("")

const params = Type.Object(
  {
    collection: Type.Optional(
      Type.String({
        description:
          "Optional case-insensitive substring to filter collections by name " +
          "(e.g. 'Enforcement'). Omit to list every collection in scope.",
        minLength: 1,
        maxLength: 255,
      }),
    ),
    maxDepth: Type.Optional(
      Type.Number({
        description:
          `Maximum folder nesting depth to include (default ${String(DEFAULT_MAX_DEPTH)}). ` +
          "Depth 1 = top-level folders only.",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
)

type Params = {
  collection?: string
  maxDepth?: number
}

type ToolArgs = {
  logger: Log
  agentScope?: AgentScope
}

// The agent's KB scope stores collection IDs as `cl-<UUID>`; agent-scope strips
// the prefix down to the bare UUID, which equals `collections.id`. Match on that
// first, with a fallback to the prefix-stripped vespaDocId for older records.
const collectionInScope = (
  c: { id: string; vespaDocId: string },
  allow: Set<string>,
): boolean =>
  allow.has(c.id) || allow.has(c.vespaDocId.replace(/^cl[-_]/, ""))

// A folder's relative segments = its parent path split into parts + its own
// name. Prefixing the collection name yields the full path Vespa stores in
// `fileName` (e.g. "Enforcements/Orders/Orders of AO").
const folderSegments = (parentPath: string, name: string): string[] =>
  [
    ...parentPath
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean),
    name.trim(),
  ].filter(Boolean)

export const buildGetFolderTreeTool = (
  args: ToolArgs,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "getFolderTree",
    label: "KB folder tree",
    description: DESCRIPTION,
    promptSnippet:
      "Use `getFolderTree` to discover the exact folder paths to scope " +
      "`vespaSearch`/`metadataSearch` with when the user names a folder/section.",
    parameters: params,
    async execute(toolCallId, raw) {
      const p = raw as Params
      const log = args.logger.child({ toolName: "getFolderTree", toolCallId })
      const startedAt = Date.now()
      const maxDepth = p.maxDepth ?? DEFAULT_MAX_DEPTH
      const nameFilter = p.collection?.trim().toLowerCase() ?? ""

      // Build the allowlist of in-scope collection IDs from the agent scope.
      // Empty allow set + present scope means the agent isn't scoped to whole
      // collections (only folders/files) — we still list everything so the
      // agent can orient, since folder/file scoping doesn't hide structure.
      const allow = new Set<string>()
      for (const sel of args.agentScope?.collectionSelections ?? []) {
        for (const id of sel.collectionIds ?? []) allow.add(id)
      }
      const enforceScope = allow.size > 0

      log.info(
        {
          agentScoped: !!args.agentScope,
          enforceScope,
          collectionFilter: nameFilter || undefined,
          maxDepth,
        },
        "tool: getFolderTree start",
      )

      try {
        const cols = await db
          .select({
            id: collections.id,
            name: collections.name,
            vespaDocId: collections.vespaDocId,
          })
          .from(collections)
          .where(isNull(collections.deletedAt))

        const scopedCols = cols
          .filter((c) => !enforceScope || collectionInScope(c, allow))
          .filter((c) => !nameFilter || c.name.toLowerCase().includes(nameFilter))

        if (scopedCols.length === 0) {
          log.info(
            { collections: 0, durationMs: Date.now() - startedAt },
            "tool: getFolderTree done (no collections)",
          )
          return textResult(`<folder_tree collections="0"/>`, {
            collections: 0,
          })
        }

        const lines: string[] = [
          `<folder_tree collections="${String(scopedCols.length)}">`,
        ]
        const tree: Array<{ collection: string; folders: string[] }> = []

        for (const col of scopedCols) {
          const folderItems = await db
            .select({
              name: collectionItems.name,
              path: collectionItems.path,
            })
            .from(collectionItems)
            .where(
              and(
                eq(collectionItems.collectionId, col.id),
                eq(collectionItems.type, "folder"),
                isNull(collectionItems.deletedAt),
              ),
            )

          const seen = new Set<string>()
          const paths: string[] = []
          for (const f of folderItems) {
            const segments = folderSegments(f.path, f.name)
            if (segments.length === 0 || segments.length > maxDepth) continue
            const full = [col.name.trim(), ...segments].join("/")
            if (seen.has(full)) continue
            seen.add(full)
            paths.push(full)
          }
          paths.sort((a, b) => a.localeCompare(b))

          lines.push(`  <collection name=${JSON.stringify(col.name)}>`)
          for (const path of paths) {
            lines.push(`    <folder path=${JSON.stringify(path)}/>`)
          }
          lines.push(`  </collection>`)
          tree.push({ collection: col.name, folders: paths })
        }

        lines.push(`</folder_tree>`)
        lines.push(
          `\nNext steps: pass a \`path\` above as the \`folder\` arg to ` +
            `\`vespaSearch\` (or \`metadataSearch\`) to scope the search to that ` +
            `folder subtree.`,
        )

        log.info(
          {
            collections: tree.length,
            folders: tree.reduce((n, t) => n + t.folders.length, 0),
            durationMs: Date.now() - startedAt,
          },
          "tool: getFolderTree done",
        )
        return textResult(lines.join("\n"), { tree })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, durationMs: Date.now() - startedAt },
          "tool: getFolderTree failed",
        )
        return textResult(`getFolderTree failed: ${msg}`, { error: msg }, true)
      }
    },
  })
