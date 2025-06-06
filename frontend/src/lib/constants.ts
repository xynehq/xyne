export const CLASS_NAMES = {
  SIDEBAR_CONTAINER: "sidebar-container",
  HISTORY_MODAL_CONTAINER: "history-modal-container",
  SEARCH_CONTAINER: "search-container",
  REFERENCE_BOX: "reference-box",
  REFERENCE_PILL: "reference-pill",
  REFERENCE_TRIGGER: "reference-trigger",
} as const

export const SELECTORS = {
  INTERACTIVE_ELEMENT: 'button, a, [role="button"], input',
  CHAT_INPUT: '[contenteditable="true"]',
  AT_MENTION_AREA: "[data-at-mention]",
} as const

// Type-safe access to class names and selectors
export type ClassNames = keyof typeof CLASS_NAMES
export type Selectors = keyof typeof SELECTORS
