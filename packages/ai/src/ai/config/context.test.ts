import { expect, test } from "bun:test";
import { formatContextForLLM } from "./context";

test("large workspaces retain the selected site while bounding the embedded catalog", () => {
	const accessibleWebsites = Array.from({ length: 100 }, (_, index) => ({
		id: `site-${index}`,
		domain: `site-${index}.example.com`,
		name: `Synthetic site ${index}`,
		createdAt: null,
		isPublic: false,
	}));
	const context = formatContextForLLM({
		accessibleWebsites,
		chatId: "synthetic-chat",
		currentDateTime: "2026-10-06T11:00:00.123Z",
		defaultWebsiteId: "site-75",
		timezone: "UTC",
	});
	expect(context.match(/<website id=/g)).toHaveLength(25);
	expect(context).toContain("25 of 100 shown");
	expect(context).toContain("<default_website_id>site-75</default_website_id>");
	expect(context).toContain("2026-10-06T11:00:00.123Z");
});
