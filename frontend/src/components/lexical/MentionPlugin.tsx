import { useEffect, useRef, useState, useCallback } from "react"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import {
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  TextNode,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
} from "lexical"
import { $createMentionNode, MentionUser, $isMentionNode } from "./MentionNode"
import { api } from "@/api"

interface MentionPluginProps {
  onMentionSearch?: (searchTerm: string) => void
}

export function MentionPlugin({ onMentionSearch }: MentionPluginProps) {
  const [editor] = useLexicalComposerContext()
  const [showDropdown, setShowDropdown] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [users, setUsers] = useState<MentionUser[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    showAbove: true,
  })
  const [isLoading, setIsLoading] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const mentionStartOffset = useRef<number | null>(null)
  const isInsertingMention = useRef(false)

  // Search users
  const searchUsers = async (query: string) => {
    if (!query.trim()) {
      setUsers([])
      return
    }

    setIsLoading(true)
    try {
      const response = await api.workspace.users.search.$get({
        query: { q: query },
      })
      if (response.ok) {
        const data = await response.json()
        setUsers(data.users || [])
      }
    } catch (error) {
      console.error("Failed to search users:", error)
      setUsers([])
    } finally {
      setIsLoading(false)
    }
  }

  // Debounce search
  useEffect(() => {
    if (!showDropdown) return

    const timeoutId = setTimeout(() => {
      searchUsers(searchTerm)
      onMentionSearch?.(searchTerm)
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [searchTerm, showDropdown])

  // Insert mention
  const insertMention = useCallback(
    (user: MentionUser) => {
      // Set flag to prevent update listener from interfering
      isInsertingMention.current = true

      // Capture the mention start offset before editor.update
      const mentionStart = mentionStartOffset.current

      if (mentionStart === null) {
        isInsertingMention.current = false
        return
      }

      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return

        const anchor = selection.anchor
        const anchorNode = anchor.getNode()

        if (!(anchorNode instanceof TextNode)) return

        const textContent = anchorNode.getTextContent()
        const cursorOffset = anchor.offset

        // Verify @ is still at the expected position
        if (textContent[mentionStart] !== "@") return

        // Get text parts
        const textBefore = textContent.substring(0, mentionStart)
        const textAfter = textContent.substring(cursorOffset)

        // Set the node text to only the text before @
        anchorNode.setTextContent(textBefore)

        // Create mention and space nodes
        const mentionNode = $createMentionNode(user)
        const spaceNode = $createTextNode(" ")

        // Insert mention after the current text
        anchorNode.insertAfter(mentionNode)
        mentionNode.insertAfter(spaceNode)

        // If there's text after, add it
        if (textAfter) {
          const afterNode = $createTextNode(textAfter)
          spaceNode.insertAfter(afterNode)
        }

        // Move cursor after the space
        spaceNode.selectEnd()
      })

      // Reset state
      setShowDropdown(false)
      setSearchTerm("")
      setUsers([])
      setSelectedIndex(0)
      mentionStartOffset.current = null
      isInsertingMention.current = false
    },
    [editor],
  )

  // Handle keyboard navigation in dropdown
  useEffect(() => {
    if (!showDropdown) return

    const removeKeyDownCommand = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        event?.preventDefault()
        if (users.length === 0) {
          return true
        }
        setSelectedIndex((prev) => (prev + 1) % users.length)
        return true
      },
      COMMAND_PRIORITY_HIGH, // Higher priority to intercept before other commands
    )

    const removeKeyUpCommand = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        event?.preventDefault()
        if (users.length === 0) {
          return true
        }
        setSelectedIndex((prev) => (prev - 1 + users.length) % users.length)
        return true
      },
      COMMAND_PRIORITY_HIGH, // Higher priority to intercept before other commands
    )

    const removeKeyEnterCommand = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // Only handle if dropdown is showing, we have users, AND the mention hasn't been inserted yet
        if (
          showDropdown &&
          users.length > 0 &&
          selectedIndex >= 0 &&
          selectedIndex < users.length &&
          mentionStartOffset.current !== null
        ) {
          event?.preventDefault()
          event?.stopPropagation()
          insertMention(users[selectedIndex])
          return true // Prevent other handlers from running
        }
        return false
      },
      COMMAND_PRIORITY_HIGH, // High priority to intercept for mention insertion
    )

    const removeKeyTabCommand = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (
          showDropdown &&
          users.length > 0 &&
          selectedIndex >= 0 &&
          selectedIndex < users.length &&
          mentionStartOffset.current !== null
        ) {
          event?.preventDefault()
          insertMention(users[selectedIndex])
          return true
        }
        return false
      },
      COMMAND_PRIORITY_LOW,
    )

    const removeKeyEscapeCommand = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault()
        setShowDropdown(false)
        setSearchTerm("")
        setUsers([])
        setSelectedIndex(0)
        mentionStartOffset.current = null
        return true
      },
      COMMAND_PRIORITY_LOW,
    )

    // Handle backspace to delete mention nodes
    const removeBackspaceCommand = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      () => {
        let handled = false
        editor.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return

          const nodes = selection.getNodes()
          const anchor = selection.anchor
          const anchorNode = anchor.getNode()

          // If selection contains mention nodes, delete them
          for (const node of nodes) {
            if ($isMentionNode(node)) {
              node.remove()
              handled = true
              return
            }
          }

          // Check if cursor is at the start of a text node
          if (anchor.offset === 0) {
            // Get the previous sibling
            const previousSibling = anchorNode.getPreviousSibling()

            // If previous sibling is a mention node, delete it
            if (previousSibling && $isMentionNode(previousSibling)) {
              previousSibling.remove()
              handled = true
              return
            }
          }

          // Check if the parent's previous sibling is a mention
          const parent = anchorNode.getParent()
          if (parent && anchor.offset === 0) {
            const parentPrevSibling = parent.getPreviousSibling()
            if (parentPrevSibling && $isMentionNode(parentPrevSibling)) {
              parentPrevSibling.remove()
              handled = true
              return
            }
          }
        })
        return handled
      },
      COMMAND_PRIORITY_HIGH,
    )

    // Handle delete key for mention nodes
    const removeDeleteCommand = editor.registerCommand(
      KEY_DELETE_COMMAND,
      () => {
        let handled = false
        editor.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return

          const nodes = selection.getNodes()
          const anchor = selection.anchor
          const anchorNode = anchor.getNode()

          // If selection contains mention nodes, delete them
          for (const node of nodes) {
            if ($isMentionNode(node)) {
              node.remove()
              handled = true
              return
            }
          }

          // Check if cursor is at the end of a text node
          if (anchor.offset === anchorNode.getTextContentSize()) {
            // Get the next sibling
            const nextSibling = anchorNode.getNextSibling()

            // If next sibling is a mention node, delete it
            if (nextSibling && $isMentionNode(nextSibling)) {
              nextSibling.remove()
              handled = true
              return
            }
          }

          // Check if the parent's next sibling is a mention
          const parent = anchorNode.getParent()
          if (parent && anchor.offset === anchorNode.getTextContentSize()) {
            const parentNextSibling = parent.getNextSibling()
            if (parentNextSibling && $isMentionNode(parentNextSibling)) {
              parentNextSibling.remove()
              handled = true
              return
            }
          }
        })
        return handled
      },
      COMMAND_PRIORITY_HIGH,
    )

    return () => {
      removeKeyDownCommand()
      removeKeyUpCommand()
      removeKeyEnterCommand()
      removeKeyTabCommand()
      removeKeyEscapeCommand()
      removeBackspaceCommand()
      removeDeleteCommand()
    }
  }, [editor, showDropdown, users, selectedIndex, insertMention])

  // Listen for @ character
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return

        const anchor = selection.anchor
        const anchorNode = anchor.getNode()

        if (!(anchorNode instanceof TextNode)) return

        const textContent = anchorNode.getTextContent()
        const cursorOffset = anchor.offset

        // Look for @ character before cursor
        const textBeforeCursor = textContent.substring(0, cursorOffset)
        const lastAtIndex = textBeforeCursor.lastIndexOf("@")

        if (lastAtIndex !== -1) {
          const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1)

          // Check if there's no space after @ and we're still typing
          if (!textAfterAt.includes(" ") && cursorOffset > lastAtIndex) {
            // Show dropdown
            setShowDropdown(true)
            setSearchTerm(textAfterAt)
            mentionStartOffset.current = lastAtIndex

            // Calculate dropdown position - default to above
            const domSelection = window.getSelection()
            if (domSelection && domSelection.rangeCount > 0) {
              const range = domSelection.getRangeAt(0)
              const rect = range.getBoundingClientRect()
              const spaceAbove = rect.top
              const spaceBelow = window.innerHeight - rect.bottom
              const dropdownHeight = 240 // Approximate height of dropdown

              // Show above by default, only show below if not enough space above
              const showAbove =
                spaceAbove >= dropdownHeight || spaceAbove > spaceBelow

              setDropdownPosition({
                top: showAbove
                  ? rect.top + window.scrollY
                  : rect.bottom + window.scrollY + 4,
                left: rect.left + window.scrollX,
                showAbove,
              })
            }

            return
          }
        }

        // Hide dropdown if conditions not met (but not if we're inserting a mention)
        if (showDropdown && !isInsertingMention.current) {
          setShowDropdown(false)
          setSearchTerm("")
          setUsers([])
          setSelectedIndex(0)
          mentionStartOffset.current = null
        }
      })
    })
  }, [editor, showDropdown])

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
        setSearchTerm("")
        setUsers([])
        setSelectedIndex(0)
      }
    }

    if (showDropdown) {
      document.addEventListener("mousedown", handleClickOutside)
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [showDropdown])

  if (!showDropdown) return null

  return (
    <div
      ref={dropdownRef}
      className="fixed z-[1000] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-60 w-64 overflow-y-auto"
      style={{
        [dropdownPosition.showAbove ? "bottom" : "top"]:
          dropdownPosition.showAbove
            ? `${window.innerHeight - dropdownPosition.top + 4}px`
            : `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
      }}
    >
      {isLoading ? (
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
          Loading...
        </div>
      ) : users.length === 0 ? (
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
          {searchTerm ? "No users found" : "Type to search users"}
        </div>
      ) : (
        <div className="py-1">
          {users.map((user, index) => (
            <button
              key={user.id}
              type="button"
              className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                index === selectedIndex ? "bg-gray-100 dark:bg-gray-700" : ""
              }`}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                insertMention(user)
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(e) => {
                // Prevent losing focus from editor
                e.preventDefault()
              }}
            >
              {user.photoLink ? (
                <img
                  src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                  alt={user.name}
                  className="w-8 h-8 rounded-full"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                    {user.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")
                      .toUpperCase()
                      .slice(0, 2)}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {user.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {user.email}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
