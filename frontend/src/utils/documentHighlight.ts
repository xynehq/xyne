// Create a namespaced object for document operations
interface DocumentOperations {
  highlightText?: (text: string) => Promise<boolean>;
  clearHighlights?: () => void;
  scrollToMatch?: (index: number) => void;
}

declare global {
  interface Window {
    __documentOperations?: DocumentOperations;
  }
}

/**
 * Utility function to highlight text in the current document
 * This function is exposed globally by the DocumentViewerContainer
 * and can be called from DocumentChat when a citation is clicked
 */

export async function highlightTextInDocument(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.__documentOperations?.highlightText) {
    return await window.__documentOperations.highlightText(text);
  }
  return false;
}

/**
 * Clear all highlights from the current document
 */
export function clearDocumentHighlights(): void {
  if (typeof window !== 'undefined' && window.__documentOperations?.clearHighlights) {
    window.__documentOperations.clearHighlights();
  }
}

/**
 * Scroll to a specific match in the document
 */
export function scrollToDocumentMatch(matchIndex: number = 0): boolean {
  if (typeof window !== 'undefined' && window.__documentOperations?.scrollToMatch) {
    const result = window.__documentOperations.scrollToMatch(matchIndex);
    return result ?? false;
  }
  return false;
} 