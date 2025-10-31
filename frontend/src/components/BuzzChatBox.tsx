import { useEffect, useState, useRef } from "react"
import {
  Bold,
  Italic,
  Code,
  List,
  ListOrdered,
  ArrowUp,
  Smile,
} from "lucide-react"
import { cn } from "@/lib/utils"
import EmojiPicker, { Theme, EmojiClickData } from "emoji-picker-react"
import { LexicalEditorState } from "@/types"

import { LexicalComposer } from "@lexical/react/LexicalComposer"
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin"
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { ListPlugin } from "@lexical/react/LexicalListPlugin"
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin"
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin"
import { HeadingNode, QuoteNode } from "@lexical/rich-text"
import { ListItemNode, ListNode } from "@lexical/list"
import { LinkNode, AutoLinkNode } from "@lexical/link"
import { CodeNode } from "@lexical/code"
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  EditorState,
  $getRoot,
  $createTextNode,
  LexicalEditor,
} from "lexical"
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  $isListItemNode,
  $createListItemNode,
} from "@lexical/list"

interface BuzzChatBoxProps {
  onSend: (editorState: LexicalEditorState) => void
  onTyping?: (isTyping: boolean) => void
  placeholder?: string
  disabled?: boolean
}

// Inline Toolbar Component (inside the editor area)
function InlineToolbarPlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext()
  const [isBold, setIsBold] = useState(false)
  const [isItalic, setIsItalic] = useState(false)
  const [isCode, setIsCode] = useState(false)

  // Track active formatting states
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          setIsBold(selection.hasFormat("bold"))
          setIsItalic(selection.hasFormat("italic"))
          setIsCode(selection.hasFormat("code"))
        }
      })
    })
  }, [editor])

  const formatBold = () => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")
  }

  const formatItalic = () => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")
  }

  const formatCode = () => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")
  }

  const insertBulletList = () => {
    editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
  }

  const insertNumberedList = () => {
    editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
  }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5">
      <button
        type="button"
        onClick={formatBold}
        className={cn(
          "p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors",
          isBold
            ? "text-gray-900 dark:text-gray-100"
            : "text-gray-500 dark:text-gray-400",
        )}
        title="Bold (Ctrl+B)"
        disabled={disabled}
      >
        <Bold size={16} />
      </button>
      <button
        type="button"
        onClick={formatItalic}
        className={cn(
          "p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors",
          isItalic
            ? "text-gray-900 dark:text-gray-100"
            : "text-gray-500 dark:text-gray-400",
        )}
        title="Italic (Ctrl+I)"
        disabled={disabled}
      >
        <Italic size={16} />
      </button>
      <button
        type="button"
        onClick={formatCode}
        className={cn(
          "p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors",
          isCode
            ? "text-gray-900 dark:text-gray-100"
            : "text-gray-500 dark:text-gray-400",
        )}
        title="Code"
        disabled={disabled}
      >
        <Code size={16} />
      </button>
      <button
        type="button"
        onClick={insertBulletList}
        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-500 dark:text-gray-400"
        title="Bullet list"
        disabled={disabled}
      >
        <List size={16} />
      </button>
      <button
        type="button"
        onClick={insertNumberedList}
        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-500 dark:text-gray-400"
        title="Numbered list"
        disabled={disabled}
      >
        <ListOrdered size={16} />
      </button>
    </div>
  )
}

// Plugin to handle Enter key for sending
function EnterKeyPlugin({
  onSend,
  disabled,
}: { onSend: () => void; disabled: boolean }) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event || disabled) {
          return false
        }

        // Shift+Enter: Create new list item if in a list
        if (event.shiftKey) {
          const selection = $getSelection()
          if ($isRangeSelection(selection)) {
            const anchorNode = selection.anchor.getNode()
            let element = anchorNode

            // Find if we're inside a list item
            while (element) {
              if ($isListItemNode(element)) {
                event.preventDefault()
                const newListItem = $createListItemNode()
                element.insertAfter(newListItem)
                newListItem.select()
                return true
              }
              const parent = element.getParent()
              if (!parent) break
              element = parent
            }
          }
          return false
        }

        // Enter without Shift: Send message
        event.preventDefault()
        onSend()
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, onSend, disabled])

  return null
}

// Plugin to clear editor after sending
function ClearEditorPlugin({ clearTrigger }: { clearTrigger: number }) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    if (clearTrigger > 0) {
      editor.update(() => {
        const root = $getRoot()
        root.clear()
      })
    }
  }, [clearTrigger, editor])

  return null
}

// Emoji Picker Plugin Component
function EmojiPickerPlugin({
  onEmojiClick,
}: {
  onEmojiClick: (emojiData: EmojiClickData, editor: LexicalEditor) => void
}) {
  const [editor] = useLexicalComposerContext()

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onEmojiClick(emojiData, editor)
  }

  return (
    <EmojiPicker
      onEmojiClick={handleEmojiClick}
      theme={Theme.AUTO}
      width={350}
      height={400}
      searchPlaceHolder="Search emoji..."
      previewConfig={{ showPreview: false }}
    />
  )
}

// Plugin to handle exiting code formatting with arrow keys
function CodeExitPlugin() {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    const handleArrowRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event: KeyboardEvent) => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false
        }

        const anchor = selection.anchor
        const node = anchor.getNode()

        if (node.getTextContent() && selection.hasFormat("code")) {
          const textLength = node.getTextContentSize()
          const offset = anchor.offset

          if (offset === textLength) {
            event.preventDefault()
            const spaceNode = $createTextNode(" ")
            node.insertAfter(spaceNode)
            spaceNode.select()
            return true
          }
        }

        return false
      },
      COMMAND_PRIORITY_LOW,
    )

    const handleArrowLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event: KeyboardEvent) => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false
        }

        const anchor = selection.anchor
        const node = anchor.getNode()

        if (node.getTextContent() && selection.hasFormat("code")) {
          const offset = anchor.offset

          if (offset === 0) {
            event.preventDefault()
            const spaceNode = $createTextNode(" ")
            node.insertBefore(spaceNode)
            spaceNode.select()
            return true
          }
        }

        return false
      },
      COMMAND_PRIORITY_LOW,
    )

    return () => {
      handleArrowRight()
      handleArrowLeft()
    }
  }, [editor])

  return null
}

// Main component
export default function BuzzChatBox({
  onSend,
  onTyping,
  placeholder = "Message...",
  disabled = false,
}: BuzzChatBoxProps) {
  const [clearTrigger, setClearTrigger] = useState(0)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const editorStateRef = useRef<EditorState | null>(null)
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isTypingRef = useRef(false)

  const handleSend = () => {
    if (!editorStateRef.current || disabled) return

    let shouldSend = false
    let jsonToSend: LexicalEditorState | null = null

    editorStateRef.current.read(() => {
      const root = $getRoot()
      const textContent = root.getTextContent().trim()

      if (textContent) {
        shouldSend = true
        jsonToSend = editorStateRef.current?.toJSON() as LexicalEditorState
      }
    })

    if (shouldSend && jsonToSend) {
      // Clear typing indicator when sending message
      if (onTyping && typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
        onTyping(false)
        isTypingRef.current = false
      }

      onSend(jsonToSend)
      setClearTrigger((prev) => prev + 1)
    }
  }

  const onChange = (editorState: EditorState) => {
    editorStateRef.current = editorState

    // Handle typing indicator if callback is provided
    if (onTyping) {
      let hasContent = false
      editorState.read(() => {
        const root = $getRoot()
        const textContent = root.getTextContent().trim()
        hasContent = textContent.length > 0
      })

      // Send typing indicator when user starts typing
      if (hasContent && !isTypingRef.current) {
        onTyping(true)
        isTypingRef.current = true
      }

      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }

      // Set timeout to send "stopped typing" after 2 seconds of inactivity
      if (hasContent) {
        typingTimeoutRef.current = setTimeout(() => {
          onTyping(false)
          isTypingRef.current = false
        }, 2000)
      } else {
        // If content is cleared, immediately send "stopped typing"
        onTyping(false)
        isTypingRef.current = false
      }
    }
  }

  // Close emoji picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(event.target as Node) &&
        emojiButtonRef.current &&
        !emojiButtonRef.current.contains(event.target as Node)
      ) {
        setShowEmojiPicker(false)
      }
    }

    if (showEmojiPicker) {
      document.addEventListener("mousedown", handleClickOutside)
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [showEmojiPicker])

  // Cleanup typing indicator on unmount
  useEffect(() => {
    return () => {
      if (onTyping && typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
        onTyping(false)
      }
    }
  }, [onTyping])

  const handleEmojiClick = (
    emojiData: EmojiClickData,
    editor: LexicalEditor,
  ) => {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText(emojiData.emoji)
      }
    })
    setShowEmojiPicker(false)
  }

  const toggleEmojiPicker = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    setShowEmojiPicker((prev) => !prev)
  }

  const initialConfig = {
    namespace: "BuzzChatBox",
    theme: {
      text: {
        bold: "font-bold",
        italic: "italic",
        code: "text-orange-600 dark:text-orange-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-mono text-xs",
        underline: "underline",
        strikethrough: "line-through",
      },
      link: "text-blue-600 dark:text-blue-400 underline cursor-pointer hover:text-blue-700",
      list: {
        ul: "list-disc list-inside my-1",
        ol: "list-decimal list-inside my-1",
        listitem: "ml-4",
        nested: {
          listitem: "list-none",
        },
      },
    },
    onError: (error: Error) => {
      console.error("Lexical error:", error)
    },
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      LinkNode,
      AutoLinkNode,
      CodeNode,
    ],
  }

  return (
    <div>
      <div className="border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-[#1E1E1E]">
        <LexicalComposer initialConfig={initialConfig}>
          {/* Inline Toolbar */}
          <InlineToolbarPlugin disabled={disabled} />

          {/* Editor Area */}
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  className={cn(
                    "w-full px-3 py-1 bg-transparent outline-none",
                    "text-gray-900 dark:text-gray-100",
                    "min-h-[40px] max-h-[300px] overflow-y-auto",
                    disabled && "opacity-50 cursor-not-allowed",
                  )}
                />
              }
              placeholder={
                <div className="absolute top-1 left-3 text-gray-400 dark:text-gray-500 pointer-events-none">
                  {placeholder}
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <OnChangePlugin onChange={onChange} />
            <HistoryPlugin />
            <ListPlugin />
            <LinkPlugin />
            <TabIndentationPlugin />
            <EnterKeyPlugin onSend={handleSend} disabled={disabled} />
            <ClearEditorPlugin clearTrigger={clearTrigger} />
            <CodeExitPlugin />
          </div>

          {/* Bottom Actions */}
          <div className="flex items-center justify-between px-3 py-1.5 relative">
            {/* Left side - emoji only */}
            <div className="relative">
              <button
                ref={emojiButtonRef}
                type="button"
                onClick={toggleEmojiPicker}
                className={cn(
                  "p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors text-gray-500 dark:text-gray-400",
                  showEmojiPicker && "bg-gray-100 dark:bg-gray-700",
                )}
                title="Add emoji"
                disabled={disabled}
              >
                <Smile size={18} />
              </button>

              {showEmojiPicker && (
                <div
                  ref={emojiPickerRef}
                  className="absolute bottom-full left-0 mb-2 z-[100]"
                >
                  <EmojiPickerPlugin onEmojiClick={handleEmojiClick} />
                </div>
              )}
            </div>

            {/* Send button */}
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled}
              className={cn(
                "p-2 rounded-md transition-colors",
                !disabled
                  ? "bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed",
              )}
              title="Send message"
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </LexicalComposer>
      </div>

      {/* Helper text outside the box */}
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        <kbd className="font-semibold">Enter</kbd> to send,{" "}
        <kbd className="font-semibold">Shift + Enter</kbd> for new line
      </div>
    </div>
  )
}
