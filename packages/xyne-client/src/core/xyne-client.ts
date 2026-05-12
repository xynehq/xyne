import { XyneApiError, XyneAuthError, XyneNetworkError } from "./errors";
import { parseSseStream } from "./sse-parser";
import type { ChatStreamEvent, SearchResponse, XyneClientConfig } from "./types";

export class XyneClient {
	private token: string;
	private readonly baseUrl: string;
	private readonly onTokenExpired: () => Promise<string>;
	private refreshPromise: Promise<string> | null = null;

	constructor(config: XyneClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.token = config.token;
		this.onTokenExpired = config.onTokenExpired;
	}

	setToken(token: string): void {
		this.token = token;
	}

	getToken(): string {
		return this.token;
	}

	async *chat(
		query: string,
		signal?: AbortSignal,
		sessionId?: string,
	): AsyncGenerator<ChatStreamEvent> {
		const payload: { query: string; session_id?: string } = { query };
		if (sessionId) payload.session_id = sessionId;
		const body = JSON.stringify(payload);

		const init: RequestInit = { method: "POST", body };
		if (signal) init.signal = signal;

		const response = await this.fetchWithRetry("/chat", init);

		if (!response.body) {
			throw new XyneNetworkError("Response body is null");
		}

		yield* parseSseStream(response.body, signal);
	}

	async *explain(
		text: string,
		signal?: AbortSignal,
	): AsyncGenerator<ChatStreamEvent> {
		const body = JSON.stringify({ text });

		const init: RequestInit = { method: "POST", body };
		if (signal) init.signal = signal;

		const response = await this.fetchWithRetry("/explain", init);

		if (!response.body) {
			throw new XyneNetworkError("Response body is null");
		}

		yield* parseSseStream(response.body, signal);
	}

	async search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
		const body = JSON.stringify({ query });

		const init: RequestInit = { method: "POST", body };
		if (signal) init.signal = signal;

		const response = await this.fetchWithRetry("/search", init);

		return (await response.json()) as SearchResponse;
	}

	private async fetchWithRetry(path: string, init: RequestInit): Promise<Response> {
		const doFetch = (token: string) =>
			fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
			});

		let response: Response;
		try {
			response = await doFetch(this.token);
		} catch (err: unknown) {
			throw new XyneNetworkError(err instanceof Error ? err.message : "Network request failed");
		}

		if (response.status === 401) {
			const newToken = await this.refreshToken();
			response = await doFetch(newToken);

			if (response.status === 401) {
				throw new XyneAuthError("Authentication failed after token refresh");
			}
		}

		if (!response.ok) {
			const errorBody = await response.json().catch(() => ({ error: "Unknown error" }));
			throw new XyneApiError(
				(errorBody as { error?: string }).error ?? "Request failed",
				response.status,
			);
		}

		return response;
	}

	private async refreshToken(): Promise<string> {
		if (this.refreshPromise === null) {
			this.refreshPromise = this.onTokenExpired().finally(() => {
				this.refreshPromise = null;
			});
		}
		const newToken = await this.refreshPromise;
		this.token = newToken;
		return newToken;
	}
}
