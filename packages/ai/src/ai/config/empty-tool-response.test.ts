import { expect, test } from "bun:test";
import type {
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { recoverEmptyToolResponse } from "./empty-tool-response";

const usage: LanguageModelV3Usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const finish: LanguageModelV3StreamPart = {
	type: "finish",
	finishReason: { unified: "stop", raw: "STOP" },
	usage,
};
const prompt = [
	{
		role: "tool" as const,
		content: [
			{
				type: "tool-result" as const,
				toolCallId: "synthetic",
				toolName: "get_data",
				output: { type: "json" as const, value: { rows: 4 } },
			},
		],
	},
];

test("retries an empty post-tool answer once, preserves results and counts both calls", async () => {
	let calls = 0;
	const source = new MockLanguageModelV3({
		doStream: async ({ prompt: retryPrompt }) => ({
			stream: convertArrayToReadableStream(
				calls++ === 0 || retryPrompt.at(-1)?.role !== "user"
					? [finish]
					: [
							{ type: "text-start", id: "answer" },
							{ type: "text-delta", id: "answer", delta: "Four sources." },
							{ type: "text-end", id: "answer" },
							finish,
						]
			),
		}),
	});
	const model = wrapLanguageModel({
		model: source,
		middleware: recoverEmptyToolResponse,
	});
	const controller = new AbortController();
	const response = await model.doStream({
		prompt,
		toolChoice: { type: "auto" },
		tools: [
			{ type: "function", name: "get_data", inputSchema: { type: "object" } },
		],
		abortSignal: controller.signal,
	});
	const chunks = await Array.fromAsync(response.stream);
	expect(source.doStreamCalls).toHaveLength(2);
	expect(source.doStreamCalls[1]).toMatchObject({
		toolChoice: { type: "none" },
		abortSignal: controller.signal,
	});
	expect(source.doStreamCalls[1]?.prompt.slice(0, -1)).toEqual(prompt);
	expect(source.doStreamCalls[1]?.tools).toBeUndefined();
	expect(chunks).toContainEqual({
		type: "text-delta",
		id: "answer",
		delta: "Four sources.",
	});
	expect(chunks.at(-1)).toMatchObject({
		usage: { inputTokens: { total: 20 } },
	});
});

test("does not retry a partial answer, further tool calls, or an initial empty response", async () => {
	for (const chunks of [
		[{ type: "text-delta", id: "answer", delta: "Partial answer" }, finish],
		[
			{
				type: "tool-call",
				toolCallId: "next",
				toolName: "get_data",
				input: "{}",
			},
			finish,
		],
	] satisfies LanguageModelV3StreamPart[][]) {
		const source = new MockLanguageModelV3({
			doStream: {
				stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(chunks),
			},
		});
		const response = await wrapLanguageModel({
			model: source,
			middleware: recoverEmptyToolResponse,
		}).doStream({ prompt });
		expect(await Array.fromAsync(response.stream)).toEqual(chunks);
		expect(source.doStreamCalls).toHaveLength(1);
	}
	const source = new MockLanguageModelV3({
		doStream: { stream: convertArrayToReadableStream([finish]) },
	});
	const response = await wrapLanguageModel({
		model: source,
		middleware: recoverEmptyToolResponse,
	}).doStream({
		prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
	});
	await Array.fromAsync(response.stream);
	expect(source.doStreamCalls).toHaveLength(1);
});

test("never repeats a tool-disabled attempt and respects cancellation before retry", async () => {
	const cancelled = new AbortController();
	cancelled.abort(new Error("Synthetic cancellation"));
	const source = new MockLanguageModelV3({
		doStream: { stream: convertArrayToReadableStream([finish]) },
	});
	const response = await wrapLanguageModel({
		model: source,
		middleware: recoverEmptyToolResponse,
	}).doStream({ prompt, abortSignal: cancelled.signal });
	await expect(Array.fromAsync(response.stream)).rejects.toThrow(
		"Synthetic cancellation"
	);
	expect(source.doStreamCalls).toHaveLength(1);
	const final = new MockLanguageModelV3({
		doStream: { stream: convertArrayToReadableStream([finish]) },
	});
	const last = await wrapLanguageModel({
		model: final,
		middleware: recoverEmptyToolResponse,
	}).doStream({ prompt, toolChoice: { type: "none" } });
	await Array.fromAsync(last.stream);
	expect(final.doStreamCalls).toHaveLength(1);
});

test("a second empty response ends without a retry loop", async () => {
	const source = new MockLanguageModelV3({
		doStream: async () => ({ stream: convertArrayToReadableStream([finish]) }),
	});
	const response = await wrapLanguageModel({
		model: source,
		middleware: recoverEmptyToolResponse,
	}).doStream({ prompt });
	const chunks = await Array.fromAsync(response.stream);
	expect(source.doStreamCalls).toHaveLength(2);
	expect(chunks).toHaveLength(1);
	expect(chunks[0]).toMatchObject({ usage: { inputTokens: { total: 20 } } });
});

test("provider errors pass through rather than being retried as empty answers", async () => {
	const error = {
		type: "error" as const,
		error: new Error("Provider unavailable"),
	};
	const source = new MockLanguageModelV3({
		doStream: { stream: convertArrayToReadableStream([error, finish]) },
	});
	const response = await wrapLanguageModel({
		model: source,
		middleware: recoverEmptyToolResponse,
	}).doStream({ prompt });
	expect(await Array.fromAsync(response.stream)).toEqual([error, finish]);
	expect(source.doStreamCalls).toHaveLength(1);
});

test("cancellation during retry setup cancels the eventual stream without a released-reader error", async () => {
	let beginRetry!: () => void;
	const retryStarted = new Promise<void>((resolve) => {
		beginRetry = resolve;
	});
	let finishRetry!: (value: {
		stream: ReadableStream<LanguageModelV3StreamPart>;
	}) => void;
	const retryReady = new Promise<{
		stream: ReadableStream<LanguageModelV3StreamPart>;
	}>((resolve) => {
		finishRetry = resolve;
	});
	let calls = 0;
	let cancelled = false;
	const source = new MockLanguageModelV3({
		doStream: async () => {
			if (calls++ === 0) {
				return { stream: convertArrayToReadableStream([finish]) };
			}
			beginRetry();
			return await retryReady;
		},
	});
	const response = await wrapLanguageModel({
		model: source,
		middleware: recoverEmptyToolResponse,
	}).doStream({ prompt });
	await retryStarted;
	await expect(
		response.stream.cancel("Client disconnected")
	).resolves.toBeUndefined();
	finishRetry({
		stream: new ReadableStream({
			cancel() {
				cancelled = true;
			},
		}),
	});
	await Bun.sleep(0);
	expect(cancelled).toBe(true);
	expect(source.doStreamCalls).toHaveLength(2);
});
