export interface XyneClientConfig {
	baseUrl: string;
	token: string;
	onTokenExpired: () => Promise<string>;
}

export interface ChatSource {
	docId: string;
	title: string;
	score: number;
	sourceUrl?: string;
}

export type ChatStreamEvent =
	| { type: "text"; content: string }
	| { type: "sources"; sources: ChatSource[] }
	| { type: "session_id"; sessionId: string }
	| { type: "done" }
	| { type: "error"; content: string };

export interface SearchResult {
	docId: string;
	title: string;
	score: number;
	sourceUrl?: string;
	content: string;
}

export interface SearchResponse {
	results: SearchResult[];
}
