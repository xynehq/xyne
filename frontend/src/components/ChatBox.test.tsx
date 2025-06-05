import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { vi } from "vitest"
import { ChatBox } from "./ChatBox" // Assuming ChatBox.tsx is in the same directory

// Mock child components or external dependencies
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-trigger">{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="dropdown-item" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
}))

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input data-testid="mock-input" {...props} />,
}))

vi.mock("./Pill", () => ({
  Pill: ({ newRef }: { newRef: any }) => (
    <div data-testid="pill">{newRef.title}</div>
  ),
}))

vi.mock("@/lib/common", () => ({
  getIcon: vi.fn((app, entity, props) => (
    <svg data-testid={`icon-${app}-${entity}`} {...props} />
  )),
}))

vi.mock("@/api", () => ({
  api: {
    search: {
      $get: vi.fn().mockResolvedValue({
        json: async () => ({ results: [], count: 0 }),
      }),
    },
  },
}))

// Mock SVG assets
vi.mock("@/assets/attach.svg?react", () => ({
  __esModule: true,
  default: (props: any) => <svg data-testid="attach-icon" {...props} />,
}))

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  ArrowRight: (props: any) => <svg data-testid="arrow-right-icon" {...props} />,
  Globe: (props: any) => <svg data-testid="globe-icon" {...props} />,
  AtSign: (props: any) => <svg data-testid="at-sign-icon" {...props} />,
  Layers: (props: any) => <svg data-testid="layers-icon" {...props} />,
  Square: (props: any) => <svg data-testid="square-icon" {...props} />,
  ChevronDown: (props: any) => (
    <svg data-testid="chevron-down-icon" {...props} />
  ),
  Check: (props: any) => <svg data-testid="check-icon" {...props} />,
  Link: (props: any) => <svg data-testid="link-icon" {...props} />,
  Search: (props: any) => <svg data-testid="search-icon" {...props} />,
  RotateCcw: (props: any) => <svg data-testid="rotate-ccw-icon" {...props} />,
  Atom: (props: any) => <svg data-testid="atom-icon" {...props} />,
}))

const mockAllCitations = new Map()
const placeholderText = "Ask anything across apps..."

const defaultProps = {
  query: "",
  setQuery: vi.fn(),
  handleSend: vi.fn(),
  isStreaming: false,
  handleStop: vi.fn(),
  chatId: null,
  allCitations: mockAllCitations,
  isReasoningActive: false,
  setIsReasoningActive: vi.fn(),
}

// Helper to get the contentEditable div
const getContentEditable = (container: HTMLElement) => {
  const contentEditableDiv = container.querySelector(
    '[data-testid="chat-input"]',
  )
  if (!contentEditableDiv)
    throw new Error(
      "ContentEditable div with data-testid='chat-input' not found",
    )
  return contentEditableDiv as HTMLDivElement
}

describe("ChatBox Placeholder Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset query for each test if props are reused
    defaultProps.query = ""
    defaultProps.setQuery.mockImplementation((newQuery) => {
      // Simulate React state update for query prop
      // This helps keep the component's internal `query` state (if derived from prop) in sync
      // For tests that rerender, this might be less critical if props are passed fresh.
    })
  })

  test("placeholder is visible initially when query is empty", () => {
    render(<ChatBox {...defaultProps} />)
    expect(screen.getByText(placeholderText)).toBeInTheDocument()
  })

  test("placeholder hides when text is typed", () => {
    const { container, rerender } = render(<ChatBox {...defaultProps} />) // Get rerender
    const inputDiv = getContentEditable(container)

    fireEvent.input(inputDiv, {
      target: { textContent: "Hello", innerHTML: "Hello" },
    })
    // The component's onInput will call setQuery, which is mocked.
    // To test the effect of the query prop changing (as if parent state updated), we use rerender.
    rerender(<ChatBox {...defaultProps} query="Hello" />)
    expect(screen.queryByText(placeholderText)).not.toBeInTheDocument()
  })

  test("placeholder hides when only spaces are typed", () => {
    const { container, rerender } = render(<ChatBox {...defaultProps} />) // Get rerender
    const inputDiv = getContentEditable(container)

    fireEvent.input(inputDiv, {
      target: { textContent: "   ", innerHTML: "&nbsp; &nbsp;&nbsp;" },
    })
    rerender(<ChatBox {...defaultProps} query="   " />)
    expect(screen.queryByText(placeholderText)).not.toBeInTheDocument()
  })

  test("placeholder hides when a newline is entered (simulating <p><br></p>)", () => {
    const { container, rerender } = render(<ChatBox {...defaultProps} />) // Get rerender
    const inputDiv = getContentEditable(container)

    fireEvent.input(inputDiv, {
      target: { textContent: "", innerHTML: "<p><br></p>" },
    })
    rerender(<ChatBox {...defaultProps} query="" />)
    expect(screen.queryByText(placeholderText)).not.toBeInTheDocument()
  })

  test("placeholder hides when a newline is entered (simulating <div><br></div>)", () => {
    const { container, rerender } = render(<ChatBox {...defaultProps} />) // Get rerender
    const inputDiv = getContentEditable(container)
    fireEvent.input(inputDiv, {
      target: { textContent: "", innerHTML: "<div><br></div>" },
    })
    rerender(<ChatBox {...defaultProps} query="" />)
    expect(screen.queryByText(placeholderText)).not.toBeInTheDocument()
  })

  test("placeholder reappears when all content (text and newlines) is cleared", () => {
    // Initial render with query="Not empty"
    const { container, rerender } = render(
      <ChatBox {...defaultProps} query="Not empty" />,
    )
    expect(
      screen.queryByText(placeholderText),
      "Placeholder initially hidden due to query prop",
    ).not.toBeInTheDocument()

    const inputDiv = getContentEditable(container)
    // Simulate clearing the input by user action
    fireEvent.input(inputDiv, { target: { textContent: "", innerHTML: "" } })
    // Then, simulate parent state update reflecting the cleared query
    rerender(<ChatBox {...defaultProps} query="" />)
    expect(
      screen.getByText(placeholderText),
      "Placeholder should be visible after clearing",
    ).toBeInTheDocument()
  })

  test("placeholder reappears when content is cleared to a single <br>", () => {
    const { container, rerender } = render(
      // Get rerender
      <ChatBox {...defaultProps} query="Not empty" />,
    )
    expect(
      screen.queryByText(placeholderText),
      "Placeholder initially hidden",
    ).not.toBeInTheDocument()

    const inputDiv = getContentEditable(container)
    fireEvent.input(inputDiv, {
      target: { textContent: "", innerHTML: "<br>" },
    })
    rerender(<ChatBox {...defaultProps} query="" />)
    expect(
      screen.getByText(placeholderText),
      "Placeholder should be visible with just <br>",
    ).toBeInTheDocument()
  })

  test("placeholder reappears when content is cleared to <p></p>", () => {
    const { container, rerender } = render(
      // Get rerender
      <ChatBox {...defaultProps} query="Not empty" />,
    )
    expect(
      screen.queryByText(placeholderText),
      "Placeholder initially hidden",
    ).not.toBeInTheDocument()

    const inputDiv = getContentEditable(container)
    fireEvent.input(inputDiv, {
      target: { textContent: "", innerHTML: "<p></p>" },
    })
    rerender(<ChatBox {...defaultProps} query="" />)
    expect(
      screen.getByText(placeholderText),
      "Placeholder should be visible with just <p></p>",
    ).toBeInTheDocument()
  })
})

describe("ChatBox @ Mention Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultProps.query = ""
    // Mock getCaretCharacterOffsetWithin and setCaretPosition as they involve Selection API
    // which might not be fully available or behave as expected in JSDOM.
    // For these tests, we are not deeply testing caret mechanics, just the outcome of the @ action.
    vi.stubGlobal(
      "getCaretCharacterOffsetWithin",
      vi.fn(() => 0),
    )
    vi.stubGlobal("setCaretPosition", vi.fn())

    // Mock getBoundingClientRect for range objects, as JSDOM doesn't implement it.
    const mockGetBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))

    const originalCreateRange = document.createRange
    vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = originalCreateRange.call(document)
      range.getBoundingClientRect = mockGetBoundingClientRect
      // Mock other range methods if they cause issues, e.g., selectNodeContents, setStart, setEnd, collapse, etc.
      // For now, only getBoundingClientRect is known to be an issue.
      // Add mocks for other properties/methods of Range if needed by the component's logic.
      range.selectNodeContents = vi.fn()
      range.setStart = vi.fn()
      range.setEnd = vi.fn()
      range.collapse = vi.fn()
      // Add any other methods that might be called on the range object by the component
      // and are not fully implemented or behave differently in JSDOM.
      return range
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("clicking @ button inserts @, calls setQuery, and shows reference box", async () => {
    const { container } = render(<ChatBox {...defaultProps} />)
    const inputDiv = getContentEditable(container)
    const atSignButton = screen.getByTestId("at-sign-icon")

    // Initial state: input is empty
    expect(inputDiv.textContent).toBe("")

    fireEvent.click(atSignButton)

    // Check if input content is updated
    // The onClick handler appends "@" or " @"
    // Since input is initially empty, it should append "@"
    expect(inputDiv.textContent).toBe("@")

    // Check if setQuery was called with the new content
    expect(defaultProps.setQuery).toHaveBeenCalledWith("@")

    expect(
      await screen.findByText(
        "Start typing to search citations from this chat.",
      ),
    ).toBeInTheDocument()
  })
})
