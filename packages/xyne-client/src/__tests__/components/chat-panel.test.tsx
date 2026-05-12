import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../../components/chat-panel/chat-panel";
import { XyneProvider } from "../../components/xyne-provider";
import type { ChatStreamEvent } from "../../core/types";

function makeSseResponse(events: ChatStreamEvent[]): Response {
	const encoder = new TextEncoder();
	const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(lines));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<XyneProvider
			baseUrl="https://api.test.com/sdk"
			token="test-token"
			onTokenExpired={async () => "refreshed"}
		>
			{children}
		</XyneProvider>
	);
}

describe("ChatPanel", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders with default placeholder", () => {
		render(<ChatPanel />, { wrapper: Wrapper });
		expect(screen.getByPlaceholderText("Ask a question...")).toBeDefined();
	});

	it("renders with custom placeholder", () => {
		render(<ChatPanel placeholder="Type here..." />, { wrapper: Wrapper });
		expect(screen.getByPlaceholderText("Type here...")).toBeDefined();
	});

	it("disables send button when input is empty", () => {
		render(<ChatPanel />, { wrapper: Wrapper });
		const sendButton = screen.getByRole("button", { name: "Send" });
		expect(sendButton).toBeDisabled();
	});

	it("enables send button when input has text", () => {
		render(<ChatPanel />, { wrapper: Wrapper });
		const input = screen.getByPlaceholderText("Ask a question...");
		fireEvent.change(input, { target: { value: "hello" } });
		const sendButton = screen.getByRole("button", { name: "Send" });
		expect(sendButton).not.toBeDisabled();
	});

	it("sends message and displays response", async () => {
		mockFetch.mockResolvedValueOnce(
			makeSseResponse([{ type: "text", content: "Hi there!" }, { type: "done" }]),
		);

		render(<ChatPanel />, { wrapper: Wrapper });

		const input = screen.getByPlaceholderText("Ask a question...");
		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.submit(input.closest("form")!);

		await waitFor(() => {
			expect(screen.getByText("hello")).toBeDefined();
			expect(screen.getByText("Hi there!")).toBeDefined();
		});
	});

	it("applies custom classNames", () => {
		render(<ChatPanel classNames={{ root: "custom-root", input: "custom-input" }} />, {
			wrapper: Wrapper,
		});

		const input = screen.getByPlaceholderText("Ask a question...");
		expect(input.className).toContain("custom-input");
	});

	it("displays sources", async () => {
		mockFetch.mockResolvedValueOnce(
			makeSseResponse([
				{ type: "text", content: "Answer" },
				{ type: "sources", sources: [{ docId: "d1", title: "Source Doc", score: 0.9 }] },
				{ type: "done" },
			]),
		);

		render(<ChatPanel />, { wrapper: Wrapper });

		const input = screen.getByPlaceholderText("Ask a question...");
		fireEvent.change(input, { target: { value: "question" } });
		fireEvent.submit(input.closest("form")!);

		await waitFor(() => {
			expect(screen.getByText("Source Doc")).toBeDefined();
		});
	});
});
