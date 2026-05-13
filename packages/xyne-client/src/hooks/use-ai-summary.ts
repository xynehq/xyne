import { useCallback, useRef, useState } from "react";
import type { ChatSource } from "../core/types";
import { useXyneClient } from "./use-xyne-client";

export interface UseAISummaryReturn {
	content: string;
	sources: ChatSource[];
	isStreaming: boolean;
	error: Error | null;
	query: (text: string) => void;
	stop: () => void;
	reset: () => void;
}

export function useAISummary(collection?: string): UseAISummaryReturn {
	const client = useXyneClient();
	const [content, setContent] = useState("");
	const [sources, setSources] = useState<ChatSource[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const stop = useCallback(() => {
		if (abortRef.current) {
			abortRef.current.abort();
			abortRef.current = null;
		}
	}, []);

	const reset = useCallback(() => {
		stop();
		setContent("");
		setSources([]);
		setError(null);
		setIsStreaming(false);
	}, [stop]);

	const query = useCallback(
		(text: string) => {
			if (isStreaming) return;

			setContent("");
			setSources([]);
			setError(null);
			setIsStreaming(true);

			const controller = new AbortController();
			abortRef.current = controller;

			void (async () => {
				try {
					let accumulated = "";

					for await (const event of client.explain(
						text,
						controller.signal,
						collection,
					)) {
						if (controller.signal.aborted) break;

						switch (event.type) {
							case "text":
								accumulated += event.content;
								setContent(accumulated);
								break;
							case "sources":
								setSources(event.sources);
								break;
							case "error":
								setError(new Error(event.content));
								setIsStreaming(false);
								abortRef.current = null;
								return;
							case "done":
								break;
						}
					}
				} catch (err) {
					if (!controller.signal.aborted) {
						setError(
							err instanceof Error ? err : new Error("Unknown error"),
						);
					}
				} finally {
					setIsStreaming(false);
					abortRef.current = null;
				}
			})();
		},
		[client, isStreaming, collection],
	);

	return { content, sources, isStreaming, error, query, stop, reset };
}
