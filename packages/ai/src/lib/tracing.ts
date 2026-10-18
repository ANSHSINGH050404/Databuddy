import { EvlogError, log } from "evlog";
import { getActiveAiRequestLogger } from "./request-logger";

export function mergeWideEvent<Fields extends object = Record<string, unknown>>(
	fields: Partial<Fields>
): void {
	const payload = fields as Record<string, unknown>;
	const requestLogger = getActiveAiRequestLogger();
	if (requestLogger) {
		requestLogger.set(payload);
		return;
	}
	log.info({ service: "api", ...payload });
}

export function captureWarning<Fields extends object = Record<string, unknown>>(
	error: unknown,
	fields?: Partial<Fields>
): void {
	const err = error instanceof Error ? error : new Error(String(error));
	const payload = fields as Record<string, unknown> | undefined;
	const requestLog = getActiveAiRequestLogger();
	if (requestLog) {
		if (payload) {
			requestLog.warn(err.message, payload);
		} else {
			requestLog.warn(err.message);
		}
		return;
	}
	log.warn({
		service: "api",
		error_message: err.message,
		...(err.stack ? { error_stack: err.stack } : {}),
		...(payload ?? {}),
	});
}

export function captureError<Fields extends object = Record<string, unknown>>(
	error: unknown,
	fields?: Partial<Fields>
): void {
	const err = error instanceof Error ? error : new Error(String(error));
	const payload = fields as Record<string, unknown> | undefined;
	const requestLog = getActiveAiRequestLogger();
	if (
		requestLog &&
		err instanceof EvlogError &&
		err.status >= 400 &&
		err.status < 500
	) {
		requestLog.set({
			client_http_error: true,
			http_status: err.status,
			error_message: err.message,
		});
		if (payload) {
			requestLog.warn(err.message, payload);
		} else {
			requestLog.warn(err.message);
		}
		return;
	}
	if (requestLog) {
		// Evlog merges repeated errors recursively. Keep SDK Error/Response causes
		// out of that mutable log context; their properties can be readonly.
		const loggedError = new Error(err.message);
		loggedError.name = err.name;
		loggedError.stack = err.stack;
		if (payload) {
			requestLog.error(loggedError, payload);
		} else {
			requestLog.error(loggedError);
		}
		return;
	}
	log.error({
		service: "api",
		error_message: err.message,
		...(payload ?? {}),
	});
}
