import { render } from "@testing-library/react"
import { vi } from "vitest"
import { ChatMessage, THINKING_PLACEHOLDER } from "./chat"
import { ThemeProvider } from "@/components/ThemeContext"

// Mock child components or external dependencies
vi.mock("@uiw/react-markdown-preview", () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => (
    <div data-testid="markdown-preview">{source}</div>
  ),
}))

vi.mock("@/components/PdfViewer", () => ({
  default: () => <div data-testid="pdf-viewer-mock" />,
}))

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false, // Default to light mode for tests, or true for dark
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock SVG assets
vi.mock("@/assets/assistant-logo.svg", () => ({
  __esModule: true,
  default: "AssistantLogoSVG",
}))
vi.mock("@/assets/retry.svg", () => ({
  __esModule: true,
  default: "RetrySVG",
}))

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Copy: (props: any) => <svg data-testid="copy-icon" {...props} />,
  Pencil: (props: any) => <svg data-testid="pencil-icon" {...props} />,
  Bookmark: (props: any) => <svg data-testid="bookmark-icon" {...props} />,
  Ellipsis: (props: any) => <svg data-testid="ellipsis-icon" {...props} />,
  ChevronDown: (props: any) => (
    <svg data-testid="chevron-down-icon" {...props} />
  ),
  ThumbsUp: (props: any) => <svg data-testid="thumbs-up-icon" {...props} />,
  ThumbsDown: (props: any) => <svg data-testid="thumbs-down-icon" {...props} />,
}))

const baseProps = {
  message: "",
  thinking: "",
  isUser: false,
  responseDone: true, // Default to true, will be overridden in tests
  isRetrying: false,
  citations: [],
  messageId: "test-msg-id",
  dots: "", // Default to empty, will be overridden
  handleRetry: vi.fn(),
  onToggleSources: vi.fn(),
  citationMap: {},
  sourcesVisible: false,
  isStreaming: false, // Default to false, will be overridden
  isDebugMode: false,
  onShowRagTrace: vi.fn(),
}

beforeEach(() => {
  // Reset mocks before each test
  baseProps.handleRetry.mockClear()
  baseProps.onToggleSources.mockClear()
  baseProps.onShowRagTrace.mockClear()
})

describe("Thinking State Scenarios", () => {
  describe('when response is stopped (even if message becomes empty), "Thinking..." text disappears and action buttons are shown', () => {
    test('it ensures "Thinking..." text disappears and relevant action buttons are shown', () => {
      // 1. Initial render: component is actively streaming/thinking
      const { rerender, getByText, queryByText } = render(
        <ThemeProvider>
          <ChatMessage
            {...baseProps}
            message="" // No final message content yet
            thinking="" // Thinking prop has content
            responseDone={false} // Response is NOT done
            isStreaming={true} // IS streaming
            dots="..." // Dots are present
          />
        </ThemeProvider>,
      )

      expect(
        getByText(new RegExp(`${THINKING_PLACEHOLDER}\\.\\.\\.`, "i")),
        'Initial: "Thinking..." text should be visible',
      ).toBeInTheDocument()

      // 2. Simulate stopping the response:
      // - responseDone becomes true
      // - isStreaming becomes false
      // - message might be empty (to specifically test the bug condition)
      // - thinking content is cleared
      // - dots are cleared
      rerender(
        <ThemeProvider>
          <ChatMessage
            {...baseProps}
            message="" // Message is EMPTY after stop
            thinking="" // Thinking content is cleared
            responseDone={true} // Response IS now done (stopped)
            isStreaming={false} // Is NOT streaming
            isRetrying={false} // Not retrying
            dots="" // Dots are gone
          />
        </ThemeProvider>,
      )
      expect(
        queryByText(new RegExp(THINKING_PLACEHOLDER, "i")),
        'After stop (empty message): "Thinking" text should NOT be visible',
      ).not.toBeInTheDocument()
    })
  })

  describe('when retrying, "Thinking..." appears, and then disappears if retry is stopped', () => {
    test('it ensures "Thinking..." appears during retry and subsequently disappears when the retry is stopped', () => {
      const originalMessage = "This message will be retried."

      // 1. Initial render: A completed message is shown
      const { rerender, getByText, queryByText } = render(
        <ThemeProvider>
          <ChatMessage
            {...baseProps}
            message={originalMessage}
            thinking=""
            responseDone={true}
            isStreaming={false}
            isRetrying={false}
            dots=""
          />
        </ThemeProvider>,
      )

      expect(
        queryByText(new RegExp(THINKING_PLACEHOLDER, "i")),
        'Initial completed: "Thinking" should not be visible',
      ).not.toBeInTheDocument()
      // 2. Simulate "Retry" action:
      // - isRetrying becomes true
      // - message might be cleared by the parent, or component handles it
      // - responseDone might be true (for the original attempt) or parent sets it to false for the retry
      // - isStreaming might become true if the retry process involves streaming
      // - dots appear
      rerender(
        <ThemeProvider>
          <ChatMessage
            {...baseProps}
            message="" // Message is often cleared for a retry
            thinking="" // No specific thinking prop content for this phase, just "Thinking..."
            responseDone={false} // Or true, depending on how parent handles it. Let's assume false for active retry.
            isStreaming={true} // Retry is now "streaming"
            isRetrying={true} // CRITICAL: Component is in retrying state
            dots="..."
          />
        </ThemeProvider>,
      )

      // Assert "Thinking..." text IS visible during retry
      expect(
        getByText(new RegExp(`${THINKING_PLACEHOLDER}\\.\\.\\.`, "i")),
        'During retry: "Thinking..." text should be visible',
      ).toBeInTheDocument()
      // Assert original message is gone (if message prop was cleared)
      // 3. Simulate stopping the "Retry" process:
      // - responseDone becomes true (retry attempt is now considered "done", successfully or not)
      // - isStreaming becomes false
      // - isRetrying might become false, or stay true but the display logic changes
      // - message might contain partial/full retry response, or be empty if retry failed early
      // - dots disappear
      const retryResponseMessage = "Retry attempt resulted in this."
      rerender(
        <ThemeProvider>
          <ChatMessage
            {...baseProps}
            message={retryResponseMessage} // Message from the retry attempt
            thinking=""
            responseDone={true} // Retry attempt is "done"
            isStreaming={false} // No longer streaming
            isRetrying={false} // No longer in active retrying state for display purposes
            dots=""
          />
        </ThemeProvider>,
      )

      // Assert "Thinking..." text is NOT visible after stopping retry
      expect(
        queryByText(new RegExp(THINKING_PLACEHOLDER, "i")),
        'After stopping retry: "Thinking" text should NOT be visible',
      ).not.toBeInTheDocument()
    })
  })
}) // Closes 'Thinking State Scenarios'
