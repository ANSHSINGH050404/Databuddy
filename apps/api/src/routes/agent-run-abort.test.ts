import { afterEach, expect, it, vi } from "vitest";
import { createAgentRunAbortController } from "./agent-run-abort";

afterEach(() => vi.useRealTimers());

it("cancels a stalled run at the total deadline", () => {
	vi.useFakeTimers();
	const run = createAgentRunAbortController(new AbortController().signal);
	vi.advanceTimersByTime(89_999);
	expect(run.signal.aborted).toBe(false);
	vi.advanceTimersByTime(1);
	expect(run.signal.aborted).toBe(true);
	expect(run.signal.reason.name).toBe("TimeoutError");
	run.cleanup();
});

it("preserves client cancellation, including requests already aborted", () => {
	vi.useFakeTimers();
	const request = new AbortController();
	const run = createAgentRunAbortController(request.signal);
	const reason = new Error("Synthetic cancellation");
	request.abort(reason);
	expect(run.signal.reason).toBe(reason);
	const alreadyAborted = createAgentRunAbortController(request.signal);
	expect(alreadyAborted.signal.reason).toBe(reason);
	run.cleanup();
	alreadyAborted.cleanup();
});

it("cleans up the deadline when a run completes", () => {
	vi.useFakeTimers();
	const run = createAgentRunAbortController(new AbortController().signal);
	run.cleanup();
	expect(vi.getTimerCount()).toBe(0);
	vi.advanceTimersByTime(90_000);
	expect(run.signal.aborted).toBe(false);
});
