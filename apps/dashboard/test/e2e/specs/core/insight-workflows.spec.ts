import type { InsightRecommendationItem } from "@databuddy/shared/insights";
import type { InsightByIdResponse } from "@/lib/insight-api";
import { expect, test, TRACKING_VERIFIED } from "@/test/e2e/fixtures";

test.beforeEach(({ mockRpc }) =>
	mockRpc("websites/isTrackingSetup", TRACKING_VERIFIED)
);

for (const definitionType of ["goal", "funnel"] as const) {
	test(`reviews an editable ${definitionType} recommendation before creating it`, {
		tag: "@regression",
	}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
		const draft = {
			name: "Successful download",
			description: "A visitor finishes their first report download",
			filters: [
				{ field: "country" as const, operator: "equals" as const, value: "US" },
			],
			ignoreHistoricData: false,
		};
		const review: Extract<
			NonNullable<InsightRecommendationItem["recommendation"]["review"]>,
			{ type: "create_goal" | "create_funnel" }
		> = definitionType === "goal"
			? {
					type: "create_goal",
					draft: { ...draft, type: "EVENT", target: "report_downloaded" },
				}
			: {
					type: "create_funnel",
					draft: {
						...draft,
						steps: [
							{
								name: "Started report",
								type: "EVENT",
								target: "report_started",
							},
							{
								name: "Downloaded report",
								type: "EVENT",
								target: "report_downloaded",
							},
						],
					},
				};
		const item: InsightRecommendationItem = {
			id: `draft-${definitionType}`,
			asOf: "2026-10-06T00:00:00Z",
			createdAt: "2026-10-06T00:00:00Z",
			expiresAt: "2026-10-13T00:00:00Z",
			status: "ready",
			saved: null,
			investigationId: null,
			websiteId: e2eSession.websiteId ?? "",
			websiteDomain: "synthetic.example",
			websiteName: "Synthetic reports",
			title: "Report downloads are collected",
			summary: "The recorded events support measuring completed downloads.",
			evidence: [
				"The current custom events include report_started and report_downloaded.",
			],
			signal: {
				signalKey: "event:report_downloaded",
				entity: {
					id: "report_downloaded",
					type: "event",
					label: "Report downloaded",
				},
				metric: { label: "Downloads", current: 20, format: "number" },
				changePercent: null,
				severity: "info",
				sentiment: "positive",
				period: {
					current: { from: "2026-09-29", to: "2026-10-05" },
					previous: { from: "2026-09-22", to: "2026-09-28" },
				},
			},
			recommendation: {
				summary: "Measure successful report downloads",
				review,
				sources: [{ source: "signal" }],
			},
		};
		const writes: unknown[] = [];
		await mockRpc("insights/recommendations", {
			hasMore: false,
			recommendations: [item],
		});
		await mockRpc("insightGeneration/getLatestRun", null);
		await mockRpc(`${definitionType}s/list`, []);
		await mockRpc(`${definitionType}s/create`, (input: unknown) => {
			writes.push(input);
			return { id: "created-definition", ...draft };
		});
		await page.goto("/insights/recommendations");
		await expect(
			page.getByRole("link", { name: "View source" })
		).toHaveAttribute(
			"href",
			`/websites/${e2eSession.websiteId}/events/report_downloaded?startDate=2026-09-29&endDate=2026-10-05`
		);
		await page
			.getByRole("link", { name: `Review ${definitionType} draft` })
			.click();
		const sheet = page.getByRole("dialog", {
			name: `Create ${definitionType}`,
			exact: true,
		});
		await expect(
			sheet.getByRole("textbox", { name: "Name", exact: true })
		).toHaveValue(draft.name);
		await expect(
			sheet.getByRole("textbox", { name: "Business meaning (optional)" })
		).toHaveValue(draft.description);
		if (definitionType === "funnel") {
			await expect(sheet.getByPlaceholder("Step name").nth(0)).toHaveValue(
				"Started report"
			);
			await expect(sheet.getByPlaceholder("Step name").nth(1)).toHaveValue(
				"Downloaded report"
			);
		}
		expect(writes).toEqual([]);
		await sheet.getByRole("button", { name: /^Cancel/ }).click();
		await expect(sheet).toBeHidden();
		if (definitionType === "funnel") {
			await page.evaluate(() =>
				window.history.pushState(null, "", "?new=funnel")
			);
		} else {
			await page
				.getByRole("button", { name: "Create goal", exact: true })
				.click();
		}
		await expect(
			sheet.getByRole("textbox", { name: "Name", exact: true })
		).toHaveValue("");
		await expect(sheet.getByText(/Review Databuddy's suggested/)).toHaveCount(
			0
		);
		await sheet.getByRole("button", { name: /^Cancel/ }).click();
		await page.goto("/insights/recommendations");
		await page
			.getByRole("link", { name: `Review ${definitionType} draft` })
			.click();
		await expect(
			sheet.getByRole("textbox", { name: "Name", exact: true })
		).toHaveValue(draft.name);
		await sheet
			.getByRole("textbox", { name: "Name", exact: true })
			.fill("Reviewed successful download");
		let failSave = true;
		await page.route(`**/rpc/${definitionType}s/create`, async (route) => {
			if (route.request().method() !== "OPTIONS" && failSave) {
				failSave = false;
				await route.abort("failed");
				return;
			}
			await route.fallback();
		});
		await sheet
			.getByRole("button", { name: new RegExp(`^Create ${definitionType}`) })
			.click();
		await expect(
			page.getByText(`Failed to create ${definitionType}`, { exact: true })
		).toBeVisible();
		await expect(
			sheet.getByRole("button", {
				name: new RegExp(`^Create ${definitionType}`),
			})
		).toBeEnabled();
		await expect(
			sheet.getByRole("textbox", { name: "Name", exact: true })
		).toHaveValue("Reviewed successful download");
		expect(writes).toHaveLength(0);
		await sheet
			.getByRole("button", { name: new RegExp(`^Create ${definitionType}`) })
			.click();
		await expect(sheet).toBeHidden();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			...review?.draft,
			name: "Reviewed successful download",
			websiteId: e2eSession.websiteId,
			recommendationId: item.id,
		});
		await mockRpc("insights/recommendations", {
			hasMore: false,
			recommendations: [
				{
					...item,
					status: "saved",
					saved: {
						definitionType,
						definitionId: "created-definition",
						name: "Reviewed successful download",
						savedAt: "2026-10-06T01:00:00Z",
						adjusted: true,
						current: true,
						deleted: false,
					},
				},
			],
		});
		await page.goto("/insights/recommendations");
		await expect(page.getByText(/Saved with your edits/)).toBeVisible();
		await expect(
			page.getByRole("link", { name: `Review ${definitionType} draft` })
		).toHaveCount(0);
		await expect(
			page.getByRole("link", { name: `View saved ${definitionType}` })
		).toHaveAttribute(
			"href",
			`/websites/${e2eSession.websiteId}/${definitionType}s?startDate=2026-09-29&endDate=2026-10-05&${definitionType}Id=created-definition`
		);
		await page.goto(
			`/websites/${e2eSession.websiteId}/${definitionType}s?recommendationId=${item.id}`
		);
		await expect(
			page.getByText("This recommendation has already been saved.")
		).toBeVisible();
		await expect(sheet).toBeHidden();
		expect(writes).toHaveLength(1);
		await expect
			.poll(() => new URL(page.url()).searchParams.get("recommendationId"))
			.toBeNull();
		await expect
			.poll(() => new URL(page.url()).searchParams.get(`${definitionType}Id`))
			.toBeNull();
		await mockRpc("insights/recommendations", {
			hasMore: false,
			recommendations: [],
		});
		await page.evaluate(
			(id) => window.history.pushState(null, "", `?recommendationId=${id}`),
			item.id
		);
		await expect(
			page.getByText(
				"This recommendation is no longer available. Review the latest recommendations."
			)
		).toBeVisible();
		await expect(sheet).toBeHidden();
		expect(writes).toHaveLength(1);
	});
}

test("does not open a blank editor for an expired recommendation", {
	tag: "@regression",
}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
	await mockRpc("insights/recommendations", {
		hasMore: false,
		recommendations: [],
	});
	await mockRpc("goals/list", []);
	await page.goto(
		`/websites/${e2eSession.websiteId}/goals?recommendationId=expired`
	);
	await expect(
		page.getByText(
			"This recommendation is no longer available. Review the latest recommendations."
		)
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("answers an investigation inline and continues it with explicit usage", {
	tag: "@regression",
}, async ({ authenticatedPage: page, e2eSession, mockRpc }) => {
	const data: InsightByIdResponse = {
		canReply: true,
		insight: {
			id: "question-case",
			description: "Download counts changed",
			title: "Report download",
			severity: "info",
			sentiment: "neutral",
			status: "open",
			resolvedReason: null,
			websiteId: e2eSession.websiteId ?? "",
			websiteDomain: "synthetic.example",
			websiteName: "Synthetic reports",
		},
		timeline: [
			{
				id: "question-observation",
				kind: "investigation",
				createdAt: "2026-10-06T00:00:00Z",
				entity: {
					id: "report_downloaded",
					type: "event",
					label: "Report downloaded",
				},
				metric: { current: 20, label: "Downloads", format: "number" },
				period: {
					current: { from: "2026-09-29", to: "2026-10-05" },
					previous: { from: "2026-09-22", to: "2026-09-28" },
				},
				outcome: {
					title: "Report downloads changed",
					summary: "The implementation owner can confirm the rollout scope.",
					rootCause: null,
					impact: null,
					evidence: ["Downloads changed in the measured period."],
					next: {
						type: "ask",
						question:
							"Was the new report download flow released to every customer?",
					},
				},
			},
		],
	};
	const writes: unknown[] = [];
	await mockRpc("insights/getById", () => data);
	await mockRpc("insights/getShare", { share: null, canPublish: false });
	await mockRpc("insights/reply", (input: unknown) => {
		writes.push(input);
		data.timeline.push({
			id: "answer-reply",
			kind: "reply",
			author: "Synthetic user",
			body: "Only the beta group received it.",
			intent: "analysis",
			createdAt: "2026-10-06T01:00:00Z",
			status: "queued",
		});
		return { reply: { id: "answer-reply", status: "queued" } };
	});
	await page.goto("/insights/question-case");
	await expect(
		page.getByText(
			"Was the new report download flow released to every customer?"
		)
	).toBeVisible();
	await expect(
		page.getByText(
			"Continuing uses 1 investigation from your allowance, then costs $1."
		)
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Your answer" })
		.fill("Only the beta group received it.");
	await page
		.getByRole("button", { name: "Answer and continue · 1 investigation" })
		.click();
	await expect(page.getByText("Reply queued…")).toBeVisible();
	expect(writes).toEqual([
		{
			body: "Only the beta group received it.",
			insightId: "question-case",
			intent: "analysis",
			acceptedPriceUsd: 1,
		},
	]);
});
