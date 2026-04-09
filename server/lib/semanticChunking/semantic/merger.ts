/**
 * Stateful text buffer with smart merging
 * Accumulates fragmented text and flushes complete paragraphs
 */

import type { BBox } from "./types"

/**
 * Text buffer state
 */
interface BufferState {
  text: string
  refs: string[]
  pages: number[]
  bboxes: Map<number, BBox>  // Track bbox per page
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
  private state: BufferState = { text: "", refs: [], pages: [], bboxes: new Map() }

  /**
   * Add text to buffer
   */
  append(text: string, ref: string, pageNumbers: number[] = [], bbox?: BBox): void {
    if (!text || text.trim().length === 0) return

    this.state.text = mergeText(this.state.text, text)
    this.state.refs.push(ref)
    if (pageNumbers.length > 0) {
      this.state.pages.push(...pageNumbers)
    }
    
    // Track bbox per page
    if (bbox && pageNumbers.length > 0) {
      for (const page of pageNumbers) {
        const existing = this.state.bboxes.get(page)
        if (!existing) {
          this.state.bboxes.set(page, { ...bbox })
        } else {
          existing.l = Math.min(existing.l, bbox.l)
          existing.t = Math.min(existing.t, bbox.t)
          existing.r = Math.max(existing.r, bbox.r)
          existing.b = Math.max(existing.b, bbox.b)
        }
      }
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
  flush(): { text: string; refs: string[]; pageNumbers: number[]; bboxes: Map<number, BBox> } | null {
    if (this.isEmpty()) return null

    const result = {
      text: this.state.text.trim(),
      refs: [...this.state.refs],
      pageNumbers: Array.from(new Set(this.state.pages)),
      bboxes: new Map(this.state.bboxes),
    }

    this.clear()
    return result
  }

  /**
   * Clear buffer without returning
   */
  clear(): void {
    this.state = { text: "", refs: [], pages: [], bboxes: new Map() }
  }

  /**
   * Peek at current buffer content without clearing
   */
  peek(): { text: string; refs: string[]; pageNumbers: number[]; bboxes: Map<number, BBox> } {
    return {
      text: this.state.text,
      refs: [...this.state.refs],
      pageNumbers: Array.from(new Set(this.state.pages)),
      bboxes: new Map(this.state.bboxes),
    }
  }
}