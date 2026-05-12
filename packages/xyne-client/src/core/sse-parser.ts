import type { ChatStreamEvent } from "./types";

export async function* parseSseStream(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let receivedAnyData = false;

	try {
		while (true) {
			if (signal?.aborted) break;

			let readResult: ReadableStreamReadResult<Uint8Array>;
			try {
				readResult = await reader.read();
			} catch (err) {
				// Stream disconnected mid-read (network failure, server crash)
				if (!signal?.aborted) {
					const message = err instanceof Error ? err.message : "Connection lost";
					yield { type: "error", content: receivedAnyData ? `Stream interrupted: ${message}` : `Connection failed: ${message}` };
				}
				return;
			}

			const { done, value } = readResult;
			if (done) break;

			receivedAnyData = true;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			let currentData: string | undefined;

			for (const line of lines) {
				if (line.startsWith("data:")) {
					currentData = line.slice(5).trim();
				} else if (line.trim() === "") {
					if (currentData !== undefined) {
						try {
							const parsed = JSON.parse(currentData) as ChatStreamEvent;
							yield parsed;
						} catch {
							// skip malformed JSON
						}
						currentData = undefined;
					}
				}
			}
		}

		// Process any remaining data in buffer
		if (buffer.startsWith("data:")) {
			const data = buffer.slice(5).trim();
			if (data.length > 0) {
				try {
					const parsed = JSON.parse(data) as ChatStreamEvent;
					yield parsed;
				} catch {
					// skip malformed
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
