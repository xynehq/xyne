import { useCallback, useRef, useState } from "react";
import type { ChatSource, ChatStreamEvent } from "../core/types";
import { useXyneClient } from "./use-xyne-client";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	sources?: ChatSource[];
	status: "complete" | "streaming" | "error";
}

export interface UseChatReturn {
	messages: ChatMessage[];
	isStreaming: boolean;
	error: Error | null;
	sendMessage: (query: string) => void;
	stop: () => void;
	clearMessages: () => void;
}

let messageCounter = 0;
function nextId(): string {
	messageCounter += 1;
	return `msg-${messageCounter}`;
}

export function useChat(): UseChatReturn {
	const client = useXyneClient();
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const sessionIdRef = useRef<string | null>(null);

	const sendMessage = useCallback(
		(query: string) => {
			const trimmed = query.trim();
			if (trimmed.length === 0 || isStreaming) return;

			setError(null);

			const userMsg: ChatMessage = {
				id: nextId(),
				role: "user",
				content: trimmed,
				status: "complete",
			};

			const assistantId = nextId();
			const assistantMsg: ChatMessage = {
				id: assistantId,
				role: "assistant",
				content: "",
				status: "streaming",
			};

			setMessages((prev) => [...prev, userMsg, assistantMsg]);
			setIsStreaming(true);

			const controller = new AbortController();
			abortRef.current = controller;

			void (async () => {
				try {
					let content = "";
					let sources: ChatSource[] | undefined;

					for await (const event of client.chat(
						trimmed,
						controller.signal,
						sessionIdRef.current ?? undefined,
					)) {
						if (controller.signal.aborted) break;

						switch (event.type) {
							case "text":
								content += event.content;
								setMessages((prev) =>
									prev.map((m) => (m.id === assistantId ? { ...m, content } : m)),
								);
								break;
							case "sources":
								sources = event.sources;
								setMessages((prev) =>
									prev.map((m) => (m.id === assistantId ? { ...m, sources: event.sources } : m)),
								);
								break;
							case "session_id":
								sessionIdRef.current = event.sessionId;
								break;
							case "error":
								setError(new Error(event.content));
								setMessages((prev) =>
									prev.map((m) =>
										m.id === assistantId ? { ...m, content: event.content, status: "error" } : m,
									),
								);
								setIsStreaming(false);
								abortRef.current = null;
								return;
							case "done":
								break;
						}
					}

					setMessages((prev) =>
						prev.map((m) => (m.id === assistantId ? { ...m, status: "complete" } : m)),
					);
				} catch (err) {
					if (!controller.signal.aborted) {
						const error = err instanceof Error ? err : new Error("Unknown error");
						setError(error);
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantId
									? { ...m, content: m.content || error.message, status: "error" }
									: m,
							),
						);
					}
				} finally {
					setIsStreaming(false);
					abortRef.current = null;
				}
			})();
		},
		[client, isStreaming],
	);

	const stop = useCallback(() => {
		if (abortRef.current) {
			abortRef.current.abort();
			abortRef.current = null;
		}
	}, []);

	const clearMessages = useCallback(() => {
		stop();
		setMessages([]);
		setError(null);
		sessionIdRef.current = null;
	}, [stop]);

	return { messages, isStreaming, error, sendMessage, stop, clearMessages };
}
