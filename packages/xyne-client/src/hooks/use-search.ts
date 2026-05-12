import { useCallback, useRef, useState } from "react";
import type { SearchResult } from "../core/types";
import { useXyneClient } from "./use-xyne-client";

export interface UseSearchReturn {
	results: SearchResult[];
	isLoading: boolean;
	error: Error | null;
	search: (query: string) => void;
	clearResults: () => void;
}

export function useSearch(): UseSearchReturn {
	const client = useXyneClient();
	const [results, setResults] = useState<SearchResult[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const search = useCallback(
		(query: string) => {
			const trimmed = query.trim();
			if (trimmed.length === 0) return;

			// Cancel any in-flight search
			if (abortRef.current) {
				abortRef.current.abort();
			}

			const controller = new AbortController();
			abortRef.current = controller;

			setIsLoading(true);
			setError(null);

			void (async () => {
				try {
					const response = await client.search(trimmed, controller.signal);
					if (!controller.signal.aborted) {
						setResults(response.results);
					}
				} catch (err) {
					if (!controller.signal.aborted) {
						setError(err instanceof Error ? err : new Error("Search failed"));
					}
				} finally {
					if (!controller.signal.aborted) {
						setIsLoading(false);
					}
					if (abortRef.current === controller) {
						abortRef.current = null;
					}
				}
			})();
		},
		[client],
	);

	const clearResults = useCallback(() => {
		if (abortRef.current) {
			abortRef.current.abort();
			abortRef.current = null;
		}
		setResults([]);
		setError(null);
		setIsLoading(false);
	}, []);

	return { results, isLoading, error, search, clearResults };
}
