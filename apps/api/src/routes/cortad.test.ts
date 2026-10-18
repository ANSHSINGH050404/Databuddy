import { describe, expect, it } from "vitest";
import { createCortadRoutes } from "./cortad";

describe("Cortad model coverage", () => {
	it.each([
		"quick",
		"balanced",
		"deep",
	])("forces %s while preserving the real chat request and response", async (tier) => {
		const body = { tier: "other", messages: [], websiteId: "test-site" };
		const app = createCortadRoutes(
			async (request) => {
				expect(new URL(request.url).pathname).toBe("/v1/agent/chat");
				expect(request.headers.get("cookie")).toBe("test=session");
				expect(await request.json()).toEqual({ ...body, tier });
				return new Response("data: [DONE]\n\n", {
					headers: { "content-type": "text/event-stream" },
				});
			},
			{ NODE_ENV: "development", DATABUDDY_CORTAD_MODE: "true" }
		);
		const response = await app.handle(
			new Request(`http://localhost/__cortad/chat/${tier}`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: "test=session" },
				body: JSON.stringify(body),
			})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe("data: [DONE]\n\n");
	});

	it.each([
		{ NODE_ENV: "production", DATABUDDY_CORTAD_MODE: "true" },
		{ NODE_ENV: "development" },
	])("does not expose test routes outside explicit development mode", async (env) => {
		const app = createCortadRoutes(async () => new Response("unexpected"), env);
		const response = await app.handle(
			new Request("http://localhost/__cortad/chat/quick", { method: "POST" })
		);
		expect(response.status).toBe(404);
	});
});
