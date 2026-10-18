const AGENT_RUN_TIMEOUT_MS = 90_000;

export function createAgentRunAbortController(
	requestSignal: AbortSignal,
	timeoutMs = AGENT_RUN_TIMEOUT_MS
) {
	const deadline = new AbortController();
	const timer = setTimeout(() => {
		deadline.abort(new DOMException("Chat run timed out", "TimeoutError"));
	}, timeoutMs);
	return {
		signal: AbortSignal.any([requestSignal, deadline.signal]),
		cleanup: () => clearTimeout(timer),
	};
}
