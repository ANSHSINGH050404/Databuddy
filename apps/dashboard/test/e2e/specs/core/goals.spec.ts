import { expect, test, TRACKING_VERIFIED } from "@/test/e2e/fixtures";
import { scopeSuffix } from "@/test/e2e/utils/dashboard";
import type { Goal } from "@/hooks/use-goals";

test.beforeEach(({ mockRpc }) =>
	mockRpc("websites/isTrackingSetup", TRACKING_VERIFIED)
);

test("creates, edits, and deletes a goal", { tag: "@core" }, async ({
	authenticatedPage: page,
	e2eSession,
}) => {
	const name = `Pricing viewed ${scopeSuffix(e2eSession)}`;
	const renamed = `${name} renamed`;
	await page.goto(`/websites/${e2eSession.websiteId}/goals`);

	await page.getByRole("button", { name: "Create goal", exact: true }).click();
	const sheet = page.getByRole("dialog", { name: "Create goal", exact: true });
	await sheet.getByRole("textbox", { name: "Name", exact: true }).fill(name);
	await sheet
		.getByRole("textbox", { name: "Business meaning (optional)" })
		.fill("A visitor considers a paid plan");
	await sheet.getByPlaceholder("/path").fill("/pricing");
	await sheet.getByRole("button", { name: /^Create goal/ }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByText(name, { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Goal actions" }).click();
	await page.getByRole("menuitem", { name: "Edit" }).click();
	const edit = page.getByRole("dialog", { name });
	await edit.getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
	await edit
		.getByRole("textbox", { name: "Business meaning (optional)" })
		.fill("");
	await edit.getByRole("button", { name: /^Save changes/ }).click();
	await expect(edit).toBeHidden();
	await expect(page.getByText(renamed, { exact: true })).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: "Goal actions" }).click();
	await page.getByRole("menuitem", { name: "Edit" }).click();
	const reopened = page.getByRole("dialog", { name: renamed });
	await expect(
		reopened.getByRole("textbox", { name: "Business meaning (optional)" })
	).toHaveValue("");
	await reopened.getByRole("button", { name: /^Cancel/ }).click();

	await page.getByRole("button", { name: "Goal actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await page
		.getByRole("dialog", { name: `Delete ${renamed}` })
		.getByRole("button", { name: "Delete goal" })
		.click();
	await expect(page.getByText(renamed, { exact: true })).toBeHidden();
});

test("keeps an investigation goal target until loading finishes and scrolls to it", {
	tag: "@regression",
}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
	const goals: Goal[] = Array.from({ length: 30 }, (_, index) => ({
		id: `goal-${index}`,
		websiteId: e2eSession.websiteId ?? "",
		name: `Goal ${index}`,
		type: "PAGE_VIEW",
		target: `/page-${index}`,
		description: null,
		filters: [],
		isActive: true,
		ignoreHistoricData: false,
		createdBy: null,
		createdAt: new Date("2026-10-01T00:00:00Z"),
		updatedAt: new Date("2026-10-01T00:00:00Z"),
		deletedAt: null,
	}));
	let releaseList = () => {};
	const pendingList = new Promise<void>((resolve) => {
		releaseList = resolve;
	});
	await mockRpc("goals/list", async () => {
		await pendingList;
		return goals;
	});
	await mockRpc("goals/bulkAnalytics", {});

	try {
		await page.goto(
			`/websites/${e2eSession.websiteId}/goals?goalId=goal-29&startDate=2026-09-20&endDate=2026-09-26#goal-goal-29`
		);
		await expect
			.poll(() => new URL(page.url()).searchParams.get("goalId"))
			.toBe("goal-29");
		releaseList();
		await expect(page.locator("#goal-goal-29")).toBeInViewport();
		await expect
			.poll(() => new URL(page.url()).searchParams.get("goalId"))
			.toBeNull();
		expect(new URL(page.url()).searchParams.get("startDate")).toBe(
			"2026-09-20"
		);
		expect(new URL(page.url()).searchParams.get("endDate")).toBe("2026-09-26");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	} finally {
		releaseList();
	}
});

test("consumes goal handoffs without losing URL context or replaying on Back and Forward", {
	tag: "@regression",
}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
	const goal: Goal = {
		id: "goal-handoff",
		websiteId: e2eSession.websiteId ?? "",
		name: "Pricing viewed",
		type: "PAGE_VIEW",
		target: "/pricing",
		description: "A visitor considers a paid plan",
		filters: [],
		isActive: true,
		ignoreHistoricData: false,
		createdBy: null,
		createdAt: new Date("2026-10-01T00:00:00Z"),
		updatedAt: new Date("2026-10-01T00:00:00Z"),
		deletedAt: null,
	};
	await mockRpc("goals/list", [goal]);
	await mockRpc("goals/bulkAnalytics", {});
	await mockRpc("insights/recommendations", {
		hasMore: false,
		recommendations: [],
	});
	let writes = 0;
	await mockRpc("goals/update", () => {
		writes++;
		return goal;
	});

	const path = `/websites/${e2eSession.websiteId}/goals`;
	const context =
		"startDate=2026-09-20&endDate=2026-09-26&granularity=hourly&view=review";
	await page.goto(`${path}?view=before`);
	await expect(page.getByText(goal.name, { exact: true })).toBeVisible();
	await page.evaluate(
		(url) => window.history.pushState(null, "", url),
		`${path}?${context}&command=edit-goal&goalId=${goal.id}&name=Reviewed+pricing&description=Reviewed+business+meaning`
	);
	const editor = page.getByRole("dialog", {
		name: "Reviewed pricing",
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
		`${path}?${context}&viewAfter=recommendation&recommendationId=unavailable-goal`
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
	expect(writes).toBe(0);
});
