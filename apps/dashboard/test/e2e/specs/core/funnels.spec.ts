import { expect, test, TRACKING_VERIFIED } from "@/test/e2e/fixtures";
import { scopeSuffix } from "@/test/e2e/utils/dashboard";
import type { Funnel, FunnelAnalyticsByReferrerResult } from "@/types/funnels";

test.beforeEach(({ mockRpc }) =>
	mockRpc("websites/isTrackingSetup", TRACKING_VERIFIED)
);

test("creates a three-step funnel and deletes it", { tag: "@core" }, async ({
	authenticatedPage: page,
	e2eSession,
}) => {
	const name = `Checkout ${scopeSuffix(e2eSession)}`;
	await page.goto(`/websites/${e2eSession.websiteId}/funnels`);

	await page
		.getByRole("button", { name: "Create funnel", exact: true })
		.click();
	const sheet = page.getByRole("dialog", {
		name: "Create funnel",
		exact: true,
	});
	await sheet.getByRole("textbox", { name: "Name", exact: true }).fill(name);
	await expect(sheet.getByPlaceholder("Step name")).toHaveCount(2);
	await sheet.getByRole("button", { name: "Add Step" }).click();
	await sheet.getByPlaceholder("Step name").nth(2).fill("Paid");
	await sheet.getByPlaceholder("/path").nth(2).fill("/thank-you");
	await sheet.getByRole("button", { name: /^Create funnel/ }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText(name, { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Funnel actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await page
		.getByRole("dialog", { name: "Delete funnel" })
		.getByRole("button", { name: "Delete funnel" })
		.click();
	await expect(page.getByText(name, { exact: true })).toBeHidden();
});

test("opens the exact investigation funnel after delayed loading and allows collapsing it", {
	tag: "@regression",
}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
	const funnels: Funnel[] = Array.from({ length: 30 }, (_, index) => ({
		id: `funnel-${index}`,
		name: `Funnel ${index}`,
		isActive: true,
		steps: [
			{ name: "Started", type: "PAGE_VIEW", target: "/checkout" },
			{ name: "Paid", type: "PAGE_VIEW", target: "/thank-you" },
		],
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
	}));
	const referrers: FunnelAnalyticsByReferrerResult[] = [
		{
			referrer: "direct",
			referrer_parsed: { name: "Direct", type: "direct", domain: "" },
			total_users: 20,
			completed_users: 10,
			conversion_rate: 50,
		},
	];
	let releaseList = () => {};
	const pendingList = new Promise<void>((resolve) => {
		releaseList = resolve;
	});
	await mockRpc("funnels/list", async () => {
		await pendingList;
		return funnels;
	});
	await mockRpc("funnels/getAnalytics", null);
	await mockRpc("funnels/getAnalyticsByReferrer", {
		referrer_analytics: referrers,
	});

	try {
		await page.goto(
			`/websites/${e2eSession.websiteId}/funnels?funnelId=funnel-29&startDate=2026-09-20&endDate=2026-09-26#funnel-funnel-29`
		);
		await expect
			.poll(() => new URL(page.url()).searchParams.get("funnelId"))
			.toBe("funnel-29");
		releaseList();
		const row = page.locator("#funnel-funnel-29");
		await expect(row).toBeInViewport();
		await expect(
			row.getByRole("region", { name: "Traffic sources" })
		).toBeVisible();
		await expect
			.poll(() => new URL(page.url()).searchParams.get("funnelId"))
			.toBeNull();
		expect(new URL(page.url()).searchParams.get("startDate")).toBe(
			"2026-09-20"
		);
		expect(new URL(page.url()).searchParams.get("endDate")).toBe("2026-09-26");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await row.getByRole("button", { name: "Funnel 29", exact: false }).click();
		await expect(
			row.getByRole("region", { name: "Traffic sources" })
		).toBeHidden();
	} finally {
		releaseList();
	}
});

test("consumes funnel handoffs without losing URL context or replaying on Back and Forward", {
	tag: "@regression",
}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
	const funnel: Funnel = {
		id: "funnel-handoff",
		name: "Checkout flow",
		description: "A visitor completes checkout",
		isActive: true,
		steps: [
			{ name: "Started", type: "PAGE_VIEW", target: "/checkout" },
			{ name: "Paid", type: "PAGE_VIEW", target: "/thank-you" },
		],
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
	};
	await mockRpc("funnels/list", [funnel]);
	await mockRpc("funnels/getAnalytics", null);
	await mockRpc("insights/recommendations", {
		hasMore: false,
		recommendations: [],
	});
	let writes = 0;
	await mockRpc("funnels/update", () => {
		writes++;
		return funnel;
	});
	await mockRpc("funnels/create", () => {
		writes++;
		return funnel;
	});

	const path = `/websites/${e2eSession.websiteId}/funnels`;
	const context =
		"startDate=2026-09-20&endDate=2026-09-26&granularity=hourly&view=review";
	await page.goto(`${path}?view=before`);
	await expect(page.getByText(funnel.name, { exact: true })).toBeVisible();
	await page.evaluate(
		(url) => window.history.pushState(null, "", url),
		`${path}?${context}&command=edit-funnel&funnelId=${funnel.id}&name=Reviewed+checkout&description=Reviewed+business+meaning`
	);
	const editor = page.getByRole("dialog", {
		name: "Reviewed checkout",
		exact: true,
	});
	await expect(editor).toBeVisible();
	await expect(
		editor.getByRole("textbox", { name: "Business meaning (optional)" })
	).toHaveValue("Reviewed business meaning");
	await expect.poll(() => new URL(page.url()).search).toBe(`?${context}`);
	await editor.getByRole("button", { name: /^Cancel/ }).click();
	await page.goBack();
	await expect.poll(() => new URL(page.url()).search).toBe("?view=before");
	await page.goForward();
	await expect.poll(() => new URL(page.url()).search).toBe(`?${context}`);
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await page.evaluate(
		(url) => window.history.pushState(null, "", url),
		`${path}?${context}&viewAfter=recommendation&recommendationId=unavailable-funnel`
	);
	const consumedRecommendation = `?${context}&viewAfter=recommendation`;
	await expect(
		page.getByText(
			"This recommendation is no longer available. Review the latest recommendations.",
			{ exact: true }
		)
	).toBeVisible();
	await expect
		.poll(() => new URL(page.url()).search)
		.toBe(consumedRecommendation);
	await page.goBack();
	await expect.poll(() => new URL(page.url()).search).toBe(`?${context}`);
	await page.goForward();
	await expect
		.poll(() => new URL(page.url()).search)
		.toBe(consumedRecommendation);
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await page.evaluate(
		(url) => window.history.pushState(null, "", url),
		`${path}?${context}&viewAfter=create&new=funnel`
	);
	const create = page.getByRole("dialog", {
		name: "Create funnel",
		exact: true,
	});
	await expect(
		create.getByRole("textbox", { name: "Name", exact: true })
	).toHaveValue("");
	await expect
		.poll(() => new URL(page.url()).search)
		.toBe(`?${context}&viewAfter=create`);
	await create.getByRole("button", { name: /^Cancel/ }).click();
	expect(writes).toBe(0);
});
