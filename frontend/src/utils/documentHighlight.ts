/**
 * Utility function to highlight text in the current document
 * This function is exposed globally by the DocumentViewerContainer
 * and can be called from DocumentChat when a citation is clicked
 */

export async function highlightTextInDocument(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && (window as any).__highlightTextInDocument) {
    return await (window as any).__highlightTextInDocument(text);
  }
  return false;
}

/**
 * Clear all highlights from the current document
 */
export function clearDocumentHighlights(): void {
  if (typeof window !== 'undefined' && (window as any).__clearDocumentHighlights) {
    (window as any).__clearDocumentHighlights();
  }
}

/**
 * Scroll to a specific match in the document
 */
export function scrollToDocumentMatch(matchIndex: number = 0): boolean {
  if (typeof window !== 'undefined' && (window as any).__scrollToDocumentMatch) {
    return (window as any).__scrollToDocumentMatch(matchIndex);
  }
  return false;
} 