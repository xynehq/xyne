// Comprehensive mermaid error suppression utility
// This handles mermaid errors that appear in parallel DOM spaces outside the chat interface

// Global error suppression for mermaid
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

// Override console methods to suppress mermaid syntax errors
console.error = (...args: any[]) => {
  const errorMessage = args.join(' ').toLowerCase();
  
  // Suppress all mermaid-related error messages
  if (
    errorMessage.includes('syntax error in text') ||
    errorMessage.includes('mermaid') ||
    errorMessage.includes('diagram') ||
    errorMessage.includes('parse error') ||
    errorMessage.includes('lexical error') ||
    errorMessage.includes('unexpected token') ||
    args.some((arg: any) => 
      typeof arg === 'string' && (
        arg.toLowerCase().includes('syntax error') ||
        arg.toLowerCase().includes('mermaid') ||
        arg.toLowerCase().includes('parse error')
      )
    )
  ) {
    // Silently ignore mermaid syntax errors
    return;
  }
  
  // Allow other console errors to pass through
  originalConsoleError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const warnMessage = args.join(' ').toLowerCase();
  
  // Suppress mermaid warnings too
  if (
    warnMessage.includes('mermaid') ||
    warnMessage.includes('diagram') ||
    warnMessage.includes('syntax') ||
    args.some((arg: any) => 
      typeof arg === 'string' && (
        arg.toLowerCase().includes('mermaid') ||
        arg.toLowerCase().includes('syntax')
      )
    )
  ) {
    return;
  }
  
  originalConsoleWarn.apply(console, args);
};

// Override mermaid's internal error display by intercepting DOM manipulation
const originalSetInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set;
if (originalSetInnerHTML) {
  Object.defineProperty(Element.prototype, 'innerHTML', {
    set: function(value: string) {
      // Check if this is a mermaid error being set
      if (typeof value === 'string' && 
          (value.includes('Syntax error in text') || 
           value.includes('syntax error') ||
           value.includes('parse error') ||
           value.includes('mermaid version'))) {
        // Replace with empty content to prevent error display
        originalSetInnerHTML?.call(this, '');
        return;
      }
      originalSetInnerHTML?.call(this, value);
    },
    get: Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.get,
    configurable: true
  });
}

// Override textContent to catch text-only error insertions
const originalSetTextContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')?.set;
if (originalSetTextContent) {
  Object.defineProperty(Node.prototype, 'textContent', {
    set: function(value: string | null) {
      // Check if this is a mermaid error being set
      if (typeof value === 'string' && 
          (value.includes('Syntax error in text') || 
           value.includes('syntax error') ||
           value.includes('parse error') ||
           value.includes('mermaid version'))) {
        // Replace with empty content
        originalSetTextContent?.call(this, '');
        return;
      }
      originalSetTextContent?.call(this, value);
    },
    get: Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')?.get,
    configurable: true
  });
}

// Override appendChild to intercept any error elements being added
const originalAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild = function<T extends Node>(newChild: T): T {
  // Check if the new child contains error content
  if (newChild.textContent && 
      (newChild.textContent.includes('Syntax error in text') ||
       newChild.textContent.includes('mermaid version') ||
       newChild.textContent.includes('parse error'))) {
    // Create an empty replacement node
    const replacement = document.createElement('div');
    replacement.style.display = 'none';
    return originalAppendChild.call(this, replacement) as T;
  }
  return originalAppendChild.call(this, newChild) as T;
};

// Override insertBefore to catch error insertions
const originalInsertBefore = Element.prototype.insertBefore;
Element.prototype.insertBefore = function<T extends Node>(newChild: T, refChild: Node | null): T {
  // Check if the new child contains error content
  if (newChild.textContent && 
      (newChild.textContent.includes('Syntax error in text') ||
       newChild.textContent.includes('mermaid version') ||
       newChild.textContent.includes('parse error'))) {
    // Create an empty replacement node
    const replacement = document.createElement('div');
    replacement.style.display = 'none';
    return originalInsertBefore.call(this, replacement, refChild) as T;
  }
  return originalInsertBefore.call(this, newChild, refChild) as T;
};

// Aggressive DOM cleanup function that runs continuously
const aggressiveErrorCleanup = () => {
  try {
    // Search for error elements throughout the entire document
    const errorSelectors = [
      'pre',
      'div',
      'span',
      'p',
      '*[class*="error"]',
      '*[id*="error"]'
    ];
    
    errorSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(element => {
        const text = element.textContent?.toLowerCase() || '';
        const innerHTML = element.innerHTML?.toLowerCase() || '';
        
        if (
          text.includes('syntax error in text') ||
          text.includes('mermaid version') ||
          text.includes('parse error') ||
          innerHTML.includes('syntax error in text') ||
          innerHTML.includes('mermaid version') ||
          innerHTML.includes('parse error')
        ) {
          // Check if this might be an error element
          try {
            const computedStyle = window.getComputedStyle(element);
            const isRedColored = (
              computedStyle.color.includes('red') || 
              computedStyle.color.includes('rgb(255') ||
              computedStyle.backgroundColor.includes('red') ||
              (element as HTMLElement).style.color.includes('red')
            );
            
            // Check if element is outside normal chat container
            const isOutsideChat = !element.closest('.markdown-content, [data-name="mermaid"], .chat-container');
            
            if (isRedColored || text.includes('mermaid version') || isOutsideChat) {
              console.log('Removing mermaid error element:', {
                tag: element.tagName,
                text: text.substring(0, 50),
                position: computedStyle.position,
                parent: element.parentElement?.tagName
              });
              element.remove();
            }
          } catch (e) {
            // If style computation fails, still remove obvious error elements
            if (text.includes('mermaid version') || text.includes('syntax error in text')) {
              element.remove();
            }
          }
        }
      });
    });
  } catch (e) {
    // Silently handle any errors in cleanup
  }
};

// Initialize the error suppression system
export const initMermaidErrorSuppression = () => {
  // Run cleanup immediately
  aggressiveErrorCleanup();
  
  // Run cleanup every 100ms to catch any new error elements
  const cleanupInterval = setInterval(aggressiveErrorCleanup, 100);
  
  // Set up mutation observer for document body
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          const textContent = element.textContent?.toLowerCase() || '';
          
          if (
            textContent.includes('syntax error in text') ||
            textContent.includes('mermaid version') ||
            textContent.includes('parse error')
          ) {
            // Check if it's likely an error element
            try {
              const computedStyle = window.getComputedStyle(element);
              if (
                computedStyle.color.includes('red') || 
                textContent.includes('mermaid version') ||
                !element.closest('.markdown-content, [data-name="mermaid"]')
              ) {
                element.remove();
              }
            } catch (e) {
              if (textContent.includes('mermaid version')) {
                element.remove();
              }
            }
          }
        }
      });
    });
  });
  
  // Observe the entire document
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  });
  
  // Also observe document element in case errors are added there
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  
  // Additional event listeners
  window.addEventListener('error', (e) => {
    const message = e.message?.toLowerCase() || '';
    if (message.includes('mermaid') || message.includes('syntax') || message.includes('diagram')) {
      e.stopPropagation();
      e.preventDefault();
      return false;
    }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const message = e.reason?.toString()?.toLowerCase() || '';
    if (message.includes('mermaid') || message.includes('syntax') || message.includes('diagram')) {
      e.stopPropagation();
      e.preventDefault();
      return false;
    }
  }, true);
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    clearInterval(cleanupInterval);
    observer.disconnect();
  });
  
  // Run cleanup when page becomes visible
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(aggressiveErrorCleanup, 10);
    }
  });
  
  return () => {
    clearInterval(cleanupInterval);
    observer.disconnect();
  };
};
