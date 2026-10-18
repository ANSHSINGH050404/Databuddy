import { expect, test } from "bun:test";
import { createConfig } from "./analytics";

const context = {
	userId: "synthetic-user",
	chatId: "synthetic-chat",
	timezone: "UTC",
};

test("chat-only configuration removes investigation tools while retaining analytics", () => {
	const config = createConfig({ ...context, investigationsEnabled: false });
	expect(config.tools.investigations).toBeUndefined();
	expect(config.tools.configure_investigations).toBeUndefined();
	expect(config.tools.get_data).toBeDefined();
	expect(config.tools.discover_query_types).toBeDefined();
});

test("normal configuration retains investigation tools", () => {
	const config = createConfig(context);
	expect(config.tools.investigations).toBeDefined();
	expect(config.tools.configure_investigations).toBeDefined();
});
