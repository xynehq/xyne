import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { SearchResult } from "../core/types";
import { useSearch } from "../hooks/use-search";
import { XyneProvider } from "./xyne-provider";

export interface XyneSearchClassNames {
	root?: string;
	inputContainer?: string;
	input?: string;
	submitButton?: string;
	resultList?: string;
	resultCard?: string;
	emptyState?: string;
	errorMessage?: string;
}

export interface XyneSearchProps {
	baseUrl: string;
	getToken: () => Promise<string>;
	placeholder?: string;
	classNames?: XyneSearchClassNames;
	renderResult?: (result: SearchResult) => React.ReactNode;
}

export function XyneSearch({
	baseUrl,
	getToken,
	placeholder,
	classNames,
	renderResult,
}: XyneSearchProps) {
	const [token, setToken] = useState<string | null>(null);
	const [authError, setAuthError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getToken()
			.then((t) => { if (!cancelled) setToken(t); })
			.catch((err) => { if (!cancelled) setAuthError(err instanceof Error ? err.message : "Failed to get token"); });
		return () => { cancelled = true; };
	}, [getToken]);

	const handleTokenExpired = useCallback(async () => {
		const newToken = await getToken();
		setToken(newToken);
		return newToken;
	}, [getToken]);

	if (authError) {
		return (
			<div className={`flex items-center justify-center h-full text-sm text-red-500 ${classNames?.root ?? ""}`}>
				{authError}
			</div>
		);
	}

	if (!token) {
		return (
			<div className={`flex items-center justify-center h-full text-sm text-gray-400 ${classNames?.root ?? ""}`}>
				Connecting...
			</div>
		);
	}

	return (
		<XyneProvider baseUrl={baseUrl} token={token} onTokenExpired={handleTokenExpired}>
			<SearchInner
				placeholder={placeholder}
				classNames={classNames}
				renderResult={renderResult}
			/>
		</XyneProvider>
	);
}

function SearchInner({
	placeholder,
	classNames,
	renderResult,
}: Pick<XyneSearchProps, "placeholder" | "classNames" | "renderResult">) {
	const { results, isLoading, error, search } = useSearch();
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const handleSubmit = useCallback(
		(e: FormEvent) => {
			e.preventDefault();
			if (value.trim().length > 0) {
				search(value.trim());
			}
		},
		[value, search],
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault();
				if (value.trim().length > 0) {
					search(value.trim());
				}
			}
		},
		[value, search],
	);

	return (
		<div className={`flex flex-col h-full ${classNames?.root ?? ""}`}>
			<form onSubmit={handleSubmit} className={`p-3 ${classNames?.inputContainer ?? ""}`}>
				<div className="flex items-center gap-2">
					<input
						ref={inputRef}
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={placeholder ?? "Search..."}
						className={`flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 transition-colors ${classNames?.input ?? ""}`}
					/>
					<button
						type="submit"
						disabled={isLoading || value.trim().length === 0}
						className={`px-4 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${classNames?.submitButton ?? ""}`}
					>
						{isLoading ? "Searching..." : "Search"}
					</button>
				</div>
			</form>

			{error && (
				<div className={`mx-3 mb-3 text-sm text-red-500 ${classNames?.errorMessage ?? ""}`}>
					{error.message}
				</div>
			)}

			<div className={`flex-1 overflow-y-auto px-3 pb-3 ${classNames?.resultList ?? ""}`}>
				{results.length === 0 && !isLoading && !error && (
					<div className={`flex items-center justify-center h-full text-sm text-gray-400 ${classNames?.emptyState ?? ""}`}>
						Search your knowledge base
					</div>
				)}
				{results.map((result) =>
					renderResult ? (
						<div key={result.docId}>{renderResult(result)}</div>
					) : (
						<div
							key={result.docId}
							className={`p-3 mb-2 bg-white border border-gray-100 rounded-lg ${classNames?.resultCard ?? ""}`}
						>
							<div className="flex items-center gap-2 mb-1">
								<svg className="shrink-0 w-3.5 h-3.5 text-gray-400" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
									<path d="M3 1h4l3 3v7H3V1z" />
									<path d="M7 1v3h3" />
								</svg>
								<span className="text-sm font-medium text-gray-900 truncate">{result.title}</span>
							</div>
							<p className="text-xs text-gray-500 line-clamp-2">{result.content}</p>
						</div>
					),
				)}
			</div>
		</div>
	);
}
