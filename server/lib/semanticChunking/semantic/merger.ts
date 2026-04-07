/**
 * Stateful text buffer with smart merging
 * Accumulates fragmented text and flushes complete paragraphs
 */

/**
 * Text buffer state
 */
interface BufferState {
  text: string
  refs: string[]
  pages: number[]
}

/**
 * Smart text merging that handles whitespace and punctuation correctly
 */
export function mergeText(buffer: string, newText: string): string {
  if (!buffer) return newText
  if (!newText) return buffer

  const trimmedNew = newText.trim()
  if (!trimmedNew) return buffer

  // Check if new text starts with punctuation - attach directly
  if (/^[.,;:!?]/.test(trimmedNew)) {
    return buffer + trimmedNew
  }

  // Check if buffer ends with whitespace - no need to add space
  if (/\s$/.test(buffer)) {
    return buffer + trimmedNew
  }

  // Default: add space between
  return buffer + " " + trimmedNew
}

/**
 * Text buffer for accumulating document fragments
 */
export class TextBuffer {
  private state: BufferState = { text: "", refs: [], pages: [] }

  /**
   * Add text to buffer
   */
  append(text: string, ref: string, pageNumbers: number[] = []): void {
    if (!text || text.trim().length === 0) return

    this.state.text = mergeText(this.state.text, text)
    this.state.refs.push(ref)
    if (pageNumbers.length > 0) {
      this.state.pages.push(...pageNumbers)
    }
  }

  /**
   * Check if buffer has content
   */
  isEmpty(): boolean {
    return this.state.text.trim().length === 0
  }

  /**
   * Get current buffer length (character count)
   */
  length(): number {
    return this.state.text.length
  }

  /**
   * Flush buffer and return accumulated content
   */
  flush(): { text: string; refs: string[]; pageNumbers: number[] } | null {
    if (this.isEmpty()) return null

    const result = {
      text: this.state.text.trim(),
      refs: [...this.state.refs],
      pageNumbers: Array.from(new Set(this.state.pages)),
    }

    this.clear()
    return result
  }

  /**
   * Clear buffer without returning
   */
  clear(): void {
    this.state = { text: "", refs: [], pages: [] }
  }

  /**
   * Peek at current buffer content without clearing
   */
  peek(): { text: string; refs: string[]; pageNumbers: number[] } {
    return {
      text: this.state.text,
      refs: [...this.state.refs],
      pageNumbers: Array.from(new Set(this.state.pages)),
    }
  }
}