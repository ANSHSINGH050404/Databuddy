import cors from "@elysiajs/cors";
import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";
import { isAllowedApiOrigin, rejectInvalidMcpOrigin } from "./cors";

describe("MCP CORS", () => {
	it("rejects an invalid MCP preflight before CORS short-circuits it", async () => {
		const app = new Elysia()
			.onRequest(({ request }) => rejectInvalidMcpOrigin(request))
			.use(cors({ credentials: true, origin: isAllowedApiOrigin }));

		const response = await app.handle(
			new Request("https://api.databuddy.test/v1/mcp", {
				method: "OPTIONS",
				headers: {
					"access-control-request-method": "POST",
					origin: "https://attacker.example",
				},
			})
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { message: "Forbidden origin" },
			id: null,
			jsonrpc: "2.0",
		});
	});
});
