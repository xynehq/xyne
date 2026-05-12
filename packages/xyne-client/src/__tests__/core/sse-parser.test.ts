import { describe, expect, it } from "vitest";
import { parseSseStream } from "../../core/sse-parser";
import type { ChatStreamEvent } from "../../core/types";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]!));
				index++;
			} else {
				controller.close();
			}
		},
	});
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of parseSseStream(stream)) {
		events.push(event);
	}
	return events;
}

describe("parseSseStream", () => {
	it("parses a single text event", async () => {
		const stream = makeStream(['data: {"type":"text","content":"hello"}\n\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "text", content: "hello" }]);
	});

	it("parses multiple events in one chunk", async () => {
		const stream = makeStream([
			'data: {"type":"text","content":"a"}\n\ndata: {"type":"text","content":"b"}\n\n',
		]);
		const events = await collectEvents(stream);
		expect(events).toEqual([
			{ type: "text", content: "a" },
			{ type: "text", content: "b" },
		]);
	});

	it("handles events split across chunks", async () => {
		const stream = makeStream(['data: {"type":"tex', 't","content":"split"}\n\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "text", content: "split" }]);
	});

	it("parses sources event", async () => {
		const data = JSON.stringify({
			type: "sources",
			sources: [{ docId: "d1", title: "Doc 1", score: 0.9 }],
		});
		const stream = makeStream([`data: ${data}\n\n`]);
		const events = await collectEvents(stream);
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("sources");
		if (events[0]?.type === "sources") {
			expect(events[0]?.sources).toHaveLength(1);
			expect(events[0]?.sources[0]?.title).toBe("Doc 1");
		}
	});

	it("parses done event", async () => {
		const stream = makeStream(['data: {"type":"done"}\n\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "done" }]);
	});

	it("parses error event", async () => {
		const stream = makeStream(['data: {"type":"error","content":"something broke"}\n\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "error", content: "something broke" }]);
	});

	it("skips malformed JSON", async () => {
		const stream = makeStream(["data: not-json\n\n", 'data: {"type":"text","content":"ok"}\n\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "text", content: "ok" }]);
	});

	it("ignores comment lines", async () => {
		const stream = makeStream([
			": this is a comment\n",
			'data: {"type":"text","content":"hi"}\n\n',
		]);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "text", content: "hi" }]);
	});

	it("handles empty stream", async () => {
		const stream = makeStream([]);
		const events = await collectEvents(stream);
		expect(events).toEqual([]);
	});

	it("respects abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = makeStream(['data: {"type":"text","content":"hi"}\n\n']);
		const events: ChatStreamEvent[] = [];
		for await (const event of parseSseStream(stream, controller.signal)) {
			events.push(event);
		}
		// Aborted before reading — no events
		expect(events).toEqual([]);
	});

	it("handles full chat sequence", async () => {
		const stream = makeStream([
			'data: {"type":"text","content":"Hello "}\n\n',
			'data: {"type":"text","content":"world"}\n\n',
			`data: ${JSON.stringify({ type: "sources", sources: [{ docId: "d1", title: "T", score: 1 }] })}\n\n`,
			'data: {"type":"done"}\n\n',
		]);
		const events = await collectEvents(stream);
		expect(events).toHaveLength(4);
		expect(events[0]?.type).toBe("text");
		expect(events[1]?.type).toBe("text");
		expect(events[2]?.type).toBe("sources");
		expect(events[3]?.type).toBe("done");
	});
});
