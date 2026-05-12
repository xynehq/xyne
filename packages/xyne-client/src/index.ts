// ─── Drop-in Components (recommended for most integrations) ─────────
export { XyneChat } from "./components/xyne-chat";
export type { XyneChatProps } from "./components/xyne-chat";
export { XyneSearch } from "./components/xyne-search";
export type { XyneSearchProps, XyneSearchClassNames } from "./components/xyne-search";
export { XyneExplain } from "./components/xyne-explain";
export type { XyneExplainProps } from "./components/xyne-explain";

// ─── Branding ────────────────────────────────────────────────────────
export { XyneLogo, XyneLogomark, PoweredByXyne, AskAIButton } from "./components/branding";
export type { XyneLogoProps, PoweredByXyneProps, AskAIButtonProps } from "./components/branding";

// ─── Primitives (for custom UI composition) ────────────────────────
export { ChatPanel } from "./components/chat-panel/chat-panel";
export type { ChatPanelProps } from "./components/chat-panel/chat-panel";
export { ChatInput } from "./components/chat-panel/chat-input";
export { MessageList } from "./components/chat-panel/message-list";
export { MessageBubble } from "./components/chat-panel/message-bubble";
export { LoadingIndicator } from "./components/chat-panel/loading-indicator";
export { MarkdownContent } from "./components/shared/markdown-content";
export { SourceList } from "./components/shared/source-list";
export { BotAvatar } from "./components/shared/bot-avatar";
export { ThinkingDots } from "./components/shared/thinking-dots";
export { AIPopover } from "./components/ai-popover/ai-popover";
export type { AIPopoverProps } from "./components/ai-popover/ai-popover";
export { TextSelectionTrigger } from "./components/ai-popover/text-selection-trigger";
export type { TextSelectionTriggerProps } from "./components/ai-popover/text-selection-trigger";
export type { ChatPanelClassNames, AIPopoverClassNames } from "./components/class-names";

// ─── Hooks (for fully custom implementations) ──────────────────────
export { useChat } from "./hooks/use-chat";
export type { ChatMessage, UseChatReturn } from "./hooks/use-chat";
export { useSearch } from "./hooks/use-search";
export type { UseSearchReturn } from "./hooks/use-search";
export { useAISummary } from "./hooks/use-ai-summary";
export type { UseAISummaryReturn } from "./hooks/use-ai-summary";
export { useXyneClient } from "./hooks/use-xyne-client";

// ─── Core (for advanced / non-React usage) ──────────────────────────
export { XyneClient } from "./core/xyne-client";
export { parseSseStream } from "./core/sse-parser";
export { XyneError, XyneAuthError, XyneNetworkError, XyneApiError } from "./core/errors";
export type {
	XyneClientConfig,
	ChatSource,
	ChatStreamEvent,
	SearchResult,
	SearchResponse,
} from "./core/types";

// ─── Provider (advanced — only needed with hooks/primitives) ────────
export { XyneProvider } from "./components/xyne-provider";
export type { XyneProviderProps } from "./components/xyne-provider";
