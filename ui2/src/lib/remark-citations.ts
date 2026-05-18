// Remark plugin: rewrites `[clf-xxx#42]` tokens inside markdown `text` nodes
// into `link` nodes with href `cite:clf-xxx#42`. ReactMarkdown's <a> renderer
// in MessageBubble detects the `cite:` scheme and replaces the link with a
// <CitationChip>.
//
// We avoid pulling in `unist-util-visit` (not in deps) — a hand-rolled walk
// is fine because mdast trees are small enough per message and the visit
// API is just a recursive traversal.

import type { Root, Text, Link, RootContent } from "mdast"

const CITATION_RE = /\[(clf-[a-z0-9-]+)#(\d+)\]/gi

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
    const docId = m[1]
    const chunk = m[2]
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
