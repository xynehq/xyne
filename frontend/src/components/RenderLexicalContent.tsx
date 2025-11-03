import React from "react"
import { LexicalEditorState, CallType } from "@/types"
import { MentionPill } from "@/components/MentionPill"

/**
 * Renders Lexical editor content with full formatting support
 * Handles mentions, links, lists, headings, quotes, and text formatting
 */
export function RenderLexicalContent({
  content,
  onMentionMessage,
  onMentionCall,
  currentUserId,
}: {
  content: LexicalEditorState
  onMentionMessage?: (userId: string) => void
  onMentionCall?: (userId: string, callType: CallType) => void
  currentUserId?: string
}) {
  const renderNode = (node: any, index: number): React.ReactNode => {
    // Text node
    if (node.type === "text") {
      let text = node.text || ""
      let element: React.ReactNode = text

      // Apply formatting
      if (node.format) {
        const format = typeof node.format === "number" ? node.format : 0
        if (format & 1) element = <strong key={index}>{element}</strong>
        if (format & 2) element = <em key={index}>{element}</em>
        if (format & 16)
          element = (
            <code
              key={index}
              className="text-orange-600 dark:text-orange-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-mono text-xs"
            >
              {element}
            </code>
          )
        if (format & 4) {
          element = <u key={`${index}-underline`}>{element}</u>
        }
        if (format & 8) {
          element = <s key={`${index}-strikethrough`}>{element}</s>
        }
        if (format & 128) {
          element = (
            <mark
              key={`${index}-highlight`}
              className="bg-yellow-200 dark:bg-yellow-800 px-1 rounded-sm"
            >
              {element}
            </mark>
          )
        }
        if (format & 32) {
          element = <sub key={`${index}-subscript`}>{element}</sub>
        }
        if (format & 64) {
          element = <sup key={`${index}-superscript`}>{element}</sup>
        }
      }

      return element
    }

    // Mention node (can be used for @user, @channel, @here)
    if (node.type === "mention") {
      // For @channel or @here mentions
      if (node.mentionType === "channel" || node.mentionType === "here") {
        return (
          <span
            key={index}
            className="inline-flex items-center bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded font-medium"
          >
            @{node.mentionType}
          </span>
        )
      }

      // Regular user mention - use MentionPill for hover functionality
      if (node.mentionUser) {
        return (
          <MentionPill
            key={index}
            user={node.mentionUser}
            onMessage={onMentionMessage}
            onCall={onMentionCall}
            currentUserId={currentUserId}
          />
        )
      }
    }

    // Link node (handles both "link" and "autolink" types)
    if (node.type === "link" || node.type === "autolink") {
      return (
        <a
          key={index}
          href={node.url || "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 underline hover:text-blue-700"
        >
          {node.children?.map(renderNode)}
        </a>
      )
    }

    // List node
    if (node.type === "list") {
      const ListTag = node.listType === "number" ? "ol" : "ul"
      return (
        <ListTag
          key={index}
          className={
            node.listType === "number"
              ? "list-decimal list-inside"
              : "list-disc list-inside"
          }
        >
          {node.children?.map(renderNode)}
        </ListTag>
      )
    }

    // List item node
    if (node.type === "listitem") {
      return <li key={index}>{node.children?.map(renderNode)}</li>
    }

    // Paragraph node
    if (node.type === "paragraph") {
      return (
        <div key={index} className="paragraph">
          {node.children?.map(renderNode)}
        </div>
      )
    }

    // Heading node
    if (node.type === "heading") {
      const tag = node.tag || "h1"
      const HeadingTag = tag as keyof JSX.IntrinsicElements
      const headingClasses: Record<string, string> = {
        h1: "text-2xl font-bold",
        h2: "text-xl font-bold",
        h3: "text-lg font-bold",
        h4: "text-base font-bold",
        h5: "text-sm font-bold",
        h6: "text-xs font-bold",
      }
      return (
        <HeadingTag key={index} className={headingClasses[tag] || ""}>
          {node.children?.map(renderNode)}
        </HeadingTag>
      )
    }

    // Quote node
    if (node.type === "quote") {
      return (
        <blockquote
          key={index}
          className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-700 dark:text-gray-300"
        >
          {node.children?.map(renderNode)}
        </blockquote>
      )
    }

    // Line break node (Shift+Enter)
    if (node.type === "linebreak") {
      return <br key={index} />
    }

    // Default: render children if they exist
    if (node.children && Array.isArray(node.children)) {
      return <span key={index}>{node.children.map(renderNode)}</span>
    }

    return null
  }

  return (
    <div className="space-y-1">
      {content.root.children.map((node, i) => renderNode(node, i))}
    </div>
  )
}
