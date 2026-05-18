// Remark plugin: rewrites `[clf-xxx#42]` tokens inside markdown `text` nodes
// into `link` nodes with href `cite:clf-xxx#42`. ReactMarkdown's <a> renderer
// in MessageBubble detects the `cite:` scheme and replaces the link with a
// <CitationChip>.
//
// We avoid pulling in `unist-util-visit` (not in deps) — a hand-rolled walk
// is fine because mdast trees are small enough per message and the visit
// API is just a recursive traversal.

import type { Root, Text, Link, RootContent } from "mdast"

// Accept the LLM-emitted citation token in any of these bracket flavors:
//   [clf-xxx#42]       ← what the system prompt requests
//   【clf-xxx#42】     ← Japanese fullwidth — Nemotron / GPT drift into this
//   ⟦clf-xxx#42⟧       ← mathematical white square (rarer drift)
// The capture is the same in every case so downstream handling stays uniform.
const CITATION_RE =
  /(?:\[(clf-[a-z0-9-]+)#(\d+)\]|【(clf-[a-z0-9-]+)#(\d+)】|⟦(clf-[a-z0-9-]+)#(\d+)⟧)/gi

type ParentLike = { children: RootContent[] }

const transformTextNode = (node: Text): RootContent[] | null => {
  const value = node.value
  const matches = [...value.matchAll(CITATION_RE)]
  if (matches.length === 0) {
    return null
  }
  const out: RootContent[] = []
  let cursor = 0
  for (const m of matches) {
    const start = m.index ?? 0
    if (start > cursor) {
      out.push({ type: "text", value: value.slice(cursor, start) } as Text)
    }
    // Each alternation has its own pair of capture groups; pick whichever
    // matched. The regex has three alternations × 2 groups so groups
    // 1/3/5 carry the docId and 2/4/6 the chunk.
    const docId = m[1] ?? m[3] ?? m[5]
    const chunk = m[2] ?? m[4] ?? m[6]
    if (!docId || !chunk) continue
    const link: Link = {
      type: "link",
      url: `cite:${docId}#${chunk}`,
      // mdast's Link expects PhrasingContent[] for children — Text is valid.
      children: [{ type: "text", value: `${docId}#${chunk}` } as Text],
    }
    out.push(link)
    cursor = start + m[0].length
  }
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) } as Text)
  }
  return out
}

const walk = (parent: ParentLike): void => {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (!child) continue
    if (child.type === "text") {
      const replaced = transformTextNode(child as Text)
      if (replaced) {
        parent.children.splice(i, 1, ...replaced)
        i += replaced.length - 1
      }
      continue
    }
    if ("children" in child && Array.isArray((child as ParentLike).children)) {
      walk(child as ParentLike)
    }
  }
}

export const remarkCitations = () => {
  return (tree: Root): void => {
    walk(tree)
  }
}
