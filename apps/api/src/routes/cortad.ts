import { buildHttpErrorResponse } from "@databuddy/shared/http-error-response";
import { Elysia } from "elysia";

export function createCortadRoutes(
	handleChat: (request: Request) => Promise<Response>,
	env: Record<string, string | undefined> = process.env
) {
	const routes = new Elysia({ prefix: "/__cortad" });
	if (env.NODE_ENV !== "development" || env.DATABUDDY_CORTAD_MODE !== "true") {
		return routes;
	}

	async function chat(request: Request, tier: "quick" | "balanced" | "deep") {
		const body: unknown = await request.json().catch(() => null);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			const error = buildHttpErrorResponse({
				code: "PARSE",
				error: new Error("Expected a chat request object"),
			});
			return Response.json(error.payload, { status: error.status });
		}
		const url = new URL(request.url);
		url.pathname = "/v1/agent/chat";
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		return handleChat(
			new Request(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ ...body, tier }),
				signal: request.signal,
			})
		);
	}

	return routes
		.post("/chat/quick", ({ request }) => chat(request, "quick"), {
			parse: "none",
		})
		.post("/chat/balanced", ({ request }) => chat(request, "balanced"), {
			parse: "none",
		})
		.post("/chat/deep", ({ request }) => chat(request, "deep"), {
			parse: "none",
		});
}
