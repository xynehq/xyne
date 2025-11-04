import { LexicalEditorState } from "@/types"

/**
 * Formats a date string into a user-friendly separator label
 * Returns "Today", "Yesterday", or formatted date based on age
 */
export const formatDateSeparator = (date: string): string => {
  const messageDate = new Date(date)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  // Reset time parts for accurate day comparison
  const resetTime = (d: Date) => {
    d.setHours(0, 0, 0, 0)
    return d
  }

  const msgDay = resetTime(new Date(messageDate))
  const todayDay = resetTime(new Date(today))
  const yesterdayDay = resetTime(new Date(yesterday))

  if (msgDay.getTime() === todayDay.getTime()) {
    return "Today"
  } else if (msgDay.getTime() === yesterdayDay.getTime()) {
    return "Yesterday"
  } else {
    // Format as "Monday, October 14th" or full date if older
    const daysDiff = Math.floor(
      (todayDay.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24),
    )

    if (daysDiff < 7) {
      // Within last week - show day name
      return messageDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    } else {
      // Older - show full date with year
      return messageDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    }
  }
}

/**
 * Formats a timestamp to localized time string
 * @param timestamp - ISO timestamp string
 * @returns Formatted time string in 12-hour format (e.g., "02:30 PM")
 */
export const formatTime = (timestamp: string): string => {
  const date = new Date(timestamp)
  return date
    .toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase()
}

/**
 * Determines if a date separator should be shown between two messages
 * Returns true if messages are on different days
 */
export const shouldShowDateSeparator = (
  currentMessage: { createdAt: string },
  previousMessage: { createdAt: string } | null,
): boolean => {
  if (!previousMessage) return true

  const currentDate = new Date(currentMessage.createdAt)
  const prevDate = new Date(previousMessage.createdAt)

  // Reset time parts for accurate day comparison
  currentDate.setHours(0, 0, 0, 0)
  prevDate.setHours(0, 0, 0, 0)

  return currentDate.getTime() !== prevDate.getTime()
}

/**
 * Extracts plain text from Lexical editor state for comparison
 * Handles mentions and nested content
 */
export const extractTextContent = (content: LexicalEditorState): string => {
  try {
    const extractText = (node: any): string => {
      if (!node) return ""
      if (node.text) return node.text
      if (node.type === "mention" && node.mentionUser) {
        return `@${node.mentionUser.name || "unknown"}`
      }
      if (node.children && Array.isArray(node.children)) {
        return node.children.map((child: any) => extractText(child)).join("")
      }
      return ""
    }
    return content.root.children.map(extractText).join("\n").trim()
  } catch (error) {
    console.error("Error extracting text content:", error)
    return ""
  }
}

/**
 * Determines if a message header should be shown
 * Returns true if different sender or more than 5 minutes apart
 * Works with both direct messages (sentByUserId) and channel messages (sender.id)
 */
export const shouldShowHeader = (
  currentMsg: {
    sentByUserId?: string
    sender?: { id: string }
    createdAt: string
  },
  prevMsg: {
    sentByUserId?: string
    sender?: { id: string }
    createdAt: string
  } | null,
): boolean => {
  if (!prevMsg) return true

  // Get sender IDs - support both message formats
  const currentSenderId = currentMsg.sentByUserId || currentMsg.sender?.id
  const prevSenderId = prevMsg.sentByUserId || prevMsg.sender?.id

  // Show header if different sender
  if (prevSenderId !== currentSenderId) return true

  // Show header if more than 5 minutes apart
  const timeDiff =
    new Date(currentMsg.createdAt).getTime() -
    new Date(prevMsg.createdAt).getTime()
  return timeDiff > 5 * 60 * 1000 // 5 minutes
}

/**
 * Compares two Lexical editor states by text content
 * First tries exact JSON comparison, then falls back to text comparison
 */
export const isContentEqual = (
  content1: LexicalEditorState,
  content2: LexicalEditorState,
): boolean => {
  try {
    // First try exact JSON comparison for perfect match
    const str1 = JSON.stringify(content1)
    const str2 = JSON.stringify(content2)
    if (str1 === str2) return true

    // If JSON doesn't match, compare by text content
    const text1 = extractTextContent(content1)
    const text2 = extractTextContent(content2)
    return text1 === text2
  } catch (error) {
    console.error("Error comparing content:", error)
    return false
  }
}
