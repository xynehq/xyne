/**
 * Citation Registry
 * 
 * Manages citations and attribution
 */

import type { Citation, FormattedCitation } from "../../models"

/**
 * Registry for managing citations
 */
export class CitationRegistry {
  private citations = new Map<string, Citation>()
  private citationIndex = new Map<number, string>()
  private nextIndex = 1
  
  /**
   * Register a citation and get its index
   */
  register(citation: Citation): number {
    const key = this.getCitationKey(citation)
    
    // Check if already registered
    for (const [index, existingKey] of this.citationIndex) {
      if (existingKey === key) {
        return index
      }
    }
    
    // Register new citation
    const index = this.nextIndex++
    this.citations.set(key, citation)
    this.citationIndex.set(index, key)
    
    return index
  }
  
  /**
   * Register multiple citations
   */
  registerMany(citations: Citation[]): Map<number, string> {
    const mapping = new Map<number, string>()
    
    for (const citation of citations) {
      const index = this.register(citation)
      mapping.set(index, citation.docId)
    }
    
    return mapping
  }
  
  /**
   * Get citation by index
   */
  getByIndex(index: number): Citation | undefined {
    const key = this.citationIndex.get(index)
    if (!key) return undefined
    return this.citations.get(key)
  }
  
  /**
   * Get all registered citations
   */
  getAll(): Array<{ index: number; citation: Citation }> {
    const result: Array<{ index: number; citation: Citation }> = []
    
    for (const [index, key] of this.citationIndex) {
      const citation = this.citations.get(key)
      if (citation) {
        result.push({ index, citation })
      }
    }
    
    return result.sort((a, b) => a.index - b.index)
  }
  
  /**
   * Format citations for client display
   */
  formatForClient(): FormattedCitation[] {
    return this.getAll().map(({ index, citation }) => ({
      index,
      docId: citation.docId,
      title: citation.title || "Unknown",
      url: citation.url,
      app: citation.app,
      entity: citation.entity,
    }))
  }
  
  /**
   * Get citation count
   */
  get count(): number {
    return this.citations.size
  }
  
  /**
   * Clear all citations
   */
  clear(): void {
    this.citations.clear()
    this.citationIndex.clear()
    this.nextIndex = 1
  }
  
  private getCitationKey(citation: Citation): string {
    return `${citation.app}:${citation.entity}:${citation.docId}:${citation.chunkIndex ?? "0"}`
  }
}

/**
 * Singleton instance
 */
export const citationRegistry = new CitationRegistry()
