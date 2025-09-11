import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";

type Options = {
  caseSensitive?: boolean;
  highlightClass?: string;
  activeClass?: string;
  matchThreshold?: number;    // 0.0 = exact match, 1.0 = very loose (default: 0.15)
  maxChunkLength?: number;    // Maximum chunk length to process (default: 200)
  debug?: boolean;            // Enable debug logging
};

type HighlightMatch = {
  startIndex: number;
  endIndex: number;
  length: number;
  similarity: number;
  highlightedText: string;
  originalLine?: string;
  processedLine?: string;
};

type HighlightResponse = {
  success: boolean;
  matches?: HighlightMatch[];
  totalMatches?: number;
  message?: string;
  debug?: any;
};

export function useScopedFind(
  containerRef: React.RefObject<HTMLElement>,
  opts: Options = {}
) {
  const { 
    caseSensitive = false,
    highlightClass = "scoped-find", 
    matchThreshold = 0.3,
    maxChunkLength = 500,
    debug = false
  } = opts;

  const [matches, setMatches] = useState<HTMLElement[]>([]);
  const [index, setIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // Extract text content from the container
  const extractContainerText = useCallback((container: HTMLElement): string => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = (n as Text).parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName.toLowerCase();
        if (tag === "script" || tag === "style") return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let text = "";
    let node: Node | null;
    while ((node = walker.nextNode())) {
      text += (node as Text).nodeValue;
    }
    
    return text;
  }, []);

  // Create highlight marks based on backend response
  const createHighlightMarks = useCallback((
    container: HTMLElement,
    match: HighlightMatch
  ): HTMLElement[] => {
    const marks: HTMLElement[] = [];
    
    try {
      // Find all text nodes and their positions
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = (n as Text).parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName.toLowerCase();
          if (tag === "script" || tag === "style") return NodeFilter.FILTER_REJECT;
          if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textNodes: { node: Text; start: number; end: number }[] = [];
      let currentPos = 0;
      let node: Node | null;
      
      // Build a map of text nodes and their positions
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const nodeLength = textNode.nodeValue!.length;
        textNodes.push({
          node: textNode,
          start: currentPos,
          end: currentPos + nodeLength
        });
        currentPos += nodeLength;
      }
      
      // Find all text nodes that intersect with our match
      const intersectingNodes = textNodes.filter(({ start, end }) => 
        start < match.endIndex && end > match.startIndex
      );
      
      // Create highlights for each intersecting text node
      for (const { node: textNode, start: nodeStart } of intersectingNodes) {
        const startOffset = Math.max(0, match.startIndex - nodeStart);
        const endOffset = Math.min(textNode.nodeValue!.length, match.endIndex - nodeStart);
        
        if (startOffset < endOffset) {
          try {
            // Create a range for this text segment
            const range = document.createRange();
            range.setStart(textNode, startOffset);
            range.setEnd(textNode, endOffset);
            
            // Create and insert the mark
            const mark = document.createElement("mark");
            mark.className = `${highlightClass}`;
            mark.setAttribute('data-match-index', '0');
            
            try {
              range.surroundContents(mark);
              marks.push(mark);
            } catch (rangeError) {
              console.warn('Failed to wrap range with mark, trying alternative approach:', rangeError);
              
              // Alternative: split text node and insert mark
              const beforeText = textNode.nodeValue!.substring(0, startOffset);
              const matchText = textNode.nodeValue!.substring(startOffset, endOffset);
              const afterText = textNode.nodeValue!.substring(endOffset);
              
              // Replace the text node content with before text
              textNode.nodeValue = beforeText;
              
              // Create and insert the mark
              const mark = document.createElement("mark");
              mark.className = `${highlightClass}`;
              mark.setAttribute('data-match-index', '0');
              mark.textContent = matchText;
              
              // Insert mark after the text node
              textNode.parentNode!.insertBefore(mark, textNode.nextSibling);
              marks.push(mark);
              
              // Insert remaining text after the mark
              if (afterText) {
                const afterNode = document.createTextNode(afterText);
                mark.parentNode!.insertBefore(afterNode, mark.nextSibling);
              }
            }
          } catch (error) {
            console.warn('Error processing text node for highlighting:', error);
          }
        }
      }
      
    } catch (error) {
      console.error('Error creating highlight marks:', error);
    }
    
    return marks;
  }, [highlightClass]);

  const clearHighlights = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    
    const marks = root.querySelectorAll<HTMLElement>(`mark.${highlightClass}`);
    marks.forEach((m) => {
      const parent = m.parentNode!;
      // unwrap <mark>
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize(); // merge adjacent text nodes
    });
    
    setMatches([]);
    setIndex(0);
  }, [containerRef, highlightClass]);

  const highlightText = useCallback(
    async (text: string): Promise<boolean> => {
      if (debug) {
        console.log('highlightText called with:', text);
      }
      
      const root = containerRef.current;
      if (!root) {
        console.log('No container ref found');
        return false;
      }
      
      if (debug) {
        console.log('Container found:', root);
      }

      clearHighlights();
      if (!text) return false;

      setIsLoading(true);
      
      try {
        // For PDFs, ensure all pages are rendered before extracting text
        if (typeof window !== 'undefined' && (window as any).__renderAllPdfPages) {
          if (debug) {
            console.log('PDF detected, rendering all pages for highlighting...');
          }
          await (window as any).__renderAllPdfPages();
        }

        const containerText = extractContainerText(root);
        
        if (debug) {
          console.log('Container text extracted, length:', containerText.length);
        }

        const response = await api.highlight.$post({
          json: {
            chunkText: text,
            documentContent: containerText,
            options: {
              matchThreshold,
              maxChunkLength,
              caseSensitive
            }
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result: HighlightResponse = await response.json();
        
        if (debug) {
          console.log('Backend response:', result);
        }

        if (!result.success || !result.matches || result.matches.length === 0) {
          if (debug) {
            console.log('No matches found:', result.message);
          }
          return false;
        }

        // Create highlight marks for all matches
        const allMarks: HTMLElement[] = [];
        let longestMatchIndex = 0;
        let longestMatchLength = 0;
        
        result.matches.forEach((match, matchIndex) => {
          const marks = createHighlightMarks(root, match);
          marks.forEach(mark => {
            mark.setAttribute('data-match-index', matchIndex.toString());
          });
          allMarks.push(...marks);
          
          if (match.length > longestMatchLength) {
            longestMatchLength = match.length;
            longestMatchIndex = allMarks.length - marks.length;
          }
        });
        
        if (debug) {
          console.log(`Created ${allMarks.length} highlight marks from ${result.matches.length} matches`);
          console.log(`Longest match index: ${longestMatchIndex} with length: ${longestMatchLength}`);
        }
        
        setMatches(allMarks);
        setIndex(longestMatchIndex);
        
        return allMarks.length > 0;
        
      } catch (error) {
        console.error('Error during backend highlighting:', error);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [clearHighlights, containerRef, extractContainerText, createHighlightMarks, matchThreshold, maxChunkLength, caseSensitive, debug]
  );

  const scrollToMatch = useCallback(
    (matchIndex: number = 0) => {
      if (!matches.length || !containerRef.current) return false;
      const bounded = ((matchIndex % matches.length) + matches.length) % matches.length;

      const container = containerRef.current;
      const target = matches[bounded];
      
      if (container.scrollHeight > container.clientHeight) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        
        const targetTop = targetRect.top - containerRect.top;
        const containerHeight = container.clientHeight;
        const targetHeight = targetRect.height;
        
        const scrollTop = container.scrollTop + targetTop - (containerHeight / 2) + (targetHeight / 2);
        
        container.scrollTo({ 
          top: Math.max(0, scrollTop), 
          behavior: 'smooth' 
        });
      } else {
        target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      }

      setIndex(bounded);
      return true;
    },
    [matches, containerRef]
  );

  // Auto-scroll to the current index (which is set to the longest match) whenever matches update
  useEffect(() => {
    if (matches.length) {
      scrollToMatch(index);
    }
  }, [matches, index, scrollToMatch]);

  // Clean up when container unmounts
  useEffect(() => () => clearHighlights(), [clearHighlights]);

  return {
    highlightText,
    clearHighlights,
    scrollToMatch,
    matches,
    index,
    isLoading,
  };
}
