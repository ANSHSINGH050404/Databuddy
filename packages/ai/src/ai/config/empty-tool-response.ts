import type {
	LanguageModelV3Middleware,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";

function addUsage(
	first: LanguageModelV3Usage,
	second: LanguageModelV3Usage
): LanguageModelV3Usage {
	const sum = (a: number | undefined, b: number | undefined) =>
		a === undefined || b === undefined ? undefined : a + b;
	return {
		inputTokens: {
			total: sum(first.inputTokens.total, second.inputTokens.total),
			noCache: sum(first.inputTokens.noCache, second.inputTokens.noCache),
			cacheRead: sum(first.inputTokens.cacheRead, second.inputTokens.cacheRead),
			cacheWrite: sum(
				first.inputTokens.cacheWrite,
				second.inputTokens.cacheWrite
			),
		},
		outputTokens: {
			total: sum(first.outputTokens.total, second.outputTokens.total),
			text: sum(first.outputTokens.text, second.outputTokens.text),
			reasoning: sum(
				first.outputTokens.reasoning,
				second.outputTokens.reasoning
			),
		},
	};
}

// Gemini Flash Lite can stop without answering after a tool result.
// Retry only an empty final response, once, without re-running any tools.
export const recoverEmptyToolResponse: LanguageModelV3Middleware = {
	specificationVersion: "v3",
	wrapStream: async ({ doStream, model, params }) => {
		const result = await doStream();
		const lastMessage = params.prompt.at(-1);
		if (lastMessage?.role !== "tool" || params.toolChoice?.type === "none") {
			return result;
		}
		let reader = result.stream.getReader();
		let readerAttached = true;
		const pending: LanguageModelV3StreamPart[] = [];
		let exposed = false;
		let firstUsage: LanguageModelV3Usage | undefined;
		let cancelled = false;
		return {
			...result,
			stream: new ReadableStream<LanguageModelV3StreamPart>({
				async pull(controller) {
					try {
						while (!cancelled) {
							const { done, value } = await reader.read();
							if (done) {
								for (const chunk of pending) {
									controller.enqueue(chunk);
								}
								pending.length = 0;
								reader.releaseLock();
								readerAttached = false;
								controller.close();
								return;
							}
							if (
								!exposed &&
								value.type === "finish" &&
								value.finishReason.unified === "stop"
							) {
								params.abortSignal?.throwIfAborted();
								firstUsage = value.usage;
								pending.length = 0;
								await reader.cancel();
								reader.releaseLock();
								readerAttached = false;
								const retry = await model.doStream({
									...params,
									prompt: [
										...params.prompt,
										{
											role: "user",
											content: [
												{
													type: "text",
													text: "Write the answer to my latest request using the tool results already returned. State the measured scope and any actual query failure; a failed query does not establish zero results. Do not run more tools or invent missing data.",
												},
											],
										},
									],
									tools: undefined,
									toolChoice: {
										type: "none",
									},
								});
								reader = retry.stream.getReader();
								readerAttached = true;
								if (cancelled) {
									await reader.cancel();
									reader.releaseLock();
									readerAttached = false;
									return;
								}
								exposed = true;
								continue;
							}
							if (exposed) {
								controller.enqueue(
									value.type === "finish" && firstUsage
										? { ...value, usage: addUsage(firstUsage, value.usage) }
										: value
								);
								return;
							}
							pending.push(value);
							const metadata =
								value.type === "stream-start" ||
								value.type === "response-metadata" ||
								value.type === "text-start" ||
								value.type === "text-end" ||
								(value.type === "text-delta" && value.delta.length === 0);
							if (!metadata || pending.length >= 32) {
								for (const chunk of pending) {
									controller.enqueue(chunk);
								}
								pending.length = 0;
								exposed = true;
								return;
							}
						}
					} catch (error) {
						if (readerAttached) {
							reader.releaseLock();
							readerAttached = false;
						}
						if (!cancelled) {
							controller.error(error);
						}
					}
				},
				async cancel(reason) {
					cancelled = true;
					if (readerAttached) {
						await reader.cancel(reason);
					}
				},
			}),
		};
	},
};
