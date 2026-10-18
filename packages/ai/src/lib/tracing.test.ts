import { afterEach, expect, test } from "bun:test";
import { createLogger } from "evlog";
import { setAiRequestLoggerProvider } from "./request-logger";
import { captureError } from "./tracing";

afterEach(() => setAiRequestLoggerProvider(null));

test("logging repeated SDK failures never mutates readonly error causes", () => {
	const logger = createLogger({ test: true });
	setAiRequestLoggerProvider(() => logger);
	const first = new Error("First provider failure");
	const second = new Error("Second provider failure");
	Object.defineProperty(first, "cause", {
		value: new Response(null, { status: 502 }),
		enumerable: true,
	});
	Object.defineProperty(second, "cause", {
		value: new Response(null, { status: 503 }),
		enumerable: true,
	});
	expect(() => {
		captureError(first);
		captureError(second);
	}).not.toThrow();
	expect(logger.getContext()).toMatchObject({
		error: { message: "Second provider failure" },
	});
	expect(first.cause).toBeInstanceOf(Response);
});
