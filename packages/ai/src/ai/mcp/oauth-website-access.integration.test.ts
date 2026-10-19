import "@databuddy/db/test-env";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

delete process.env.SLACK_WEBHOOK_URL;

const integration =
	process.env.MCP_OAUTH_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integration("MCP OAuth website authorization", () => {
	let toolContext: typeof import("./tool-context");
	let mcpTools: typeof import("./tools");
	let dbModule: typeof import("@databuddy/db");
	let schema: typeof import("@databuddy/db/schema");
	let viewer: typeof schema.user.$inferSelect;
	let outsider: typeof schema.user.$inferSelect;
	let multiOrg: typeof schema.user.$inferSelect;

	const suffix = randomUUID().slice(0, 8);
	const organizationId = `mcp-oauth-org-${suffix}`;
	const otherOrganizationId = `mcp-oauth-other-org-${suffix}`;
	const websiteId = `mcp-oauth-site-${suffix}`;
	const otherWebsiteId = `mcp-oauth-other-site-${suffix}`;
	const viewerId = `mcp-oauth-viewer-${suffix}`;
	const outsiderId = `mcp-oauth-outsider-${suffix}`;
	const multiOrgId = `mcp-oauth-multi-org-${suffix}`;
	const userIds = [viewerId, outsiderId, multiOrgId];

	async function insertUser(id: string) {
		const now = new Date();
		const [user] = await dbModule.db
			.insert(schema.user)
			.values({
				id,
				name: id,
				email: `${id}@example.com`,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		if (!user) {
			throw new Error("Test user was not created");
		}
		return user;
	}

	beforeAll(async () => {
		dbModule = await import("@databuddy/db");
		schema = await import("@databuddy/db/schema");
		toolContext = await import("./tool-context");
		mcpTools = await import("./tools");

		const now = new Date();
		await dbModule.db.insert(schema.organization).values([
			{ id: organizationId, name: organizationId, createdAt: now },
			{ id: otherOrganizationId, name: otherOrganizationId, createdAt: now },
		]);
		viewer = await insertUser(viewerId);
		outsider = await insertUser(outsiderId);
		multiOrg = await insertUser(multiOrgId);
		await dbModule.db.insert(schema.member).values([
			{
				id: `member-${viewerId}`,
				organizationId,
				userId: viewerId,
				role: "viewer",
				createdAt: now,
			},
			{
				id: `member-${outsiderId}`,
				organizationId: otherOrganizationId,
				userId: outsiderId,
				role: "owner",
				createdAt: now,
			},
			{
				id: `member-${multiOrgId}`,
				organizationId,
				userId: multiOrgId,
				role: "viewer",
				createdAt: now,
			},
			{
				id: `member-other-${multiOrgId}`,
				organizationId: otherOrganizationId,
				userId: multiOrgId,
				role: "viewer",
				createdAt: now,
			},
		]);
		await dbModule.db.insert(schema.websites).values([
			{
				id: websiteId,
				domain: `${websiteId}.example.com`,
				organizationId,
			},
			{
				id: otherWebsiteId,
				domain: `${otherWebsiteId}.example.com`,
				organizationId: otherOrganizationId,
			},
		]);
	});

	afterAll(async () => {
		const { db, inArray } = dbModule;
		await db
			.delete(schema.feedback)
			.where(inArray(schema.feedback.userId, userIds));
		await db
			.delete(schema.websites)
			.where(inArray(schema.websites.id, [websiteId, otherWebsiteId]));
		await db
			.delete(schema.member)
			.where(inArray(schema.member.userId, userIds));
		await db.delete(schema.user).where(inArray(schema.user.id, userIds));
		await db
			.delete(schema.organization)
			.where(
				inArray(schema.organization.id, [organizationId, otherOrganizationId])
			);
		await db.$client.end();
	});

	test("grants a member of the website's organization", async () => {
		await expect(
			toolContext.ensureWebsiteAccess(websiteId, {
				apiKey: null,
				oauth: {
					grant: { organizationId, websiteIds: [websiteId] },
					scopes: ["read:data"],
					user: viewer,
				},
				requestHeaders: new Headers(),
				userId: null,
			})
		).resolves.toMatchObject({ domain: `${websiteId}.example.com` });
	});

	test("denies a user who belongs to a different organization", async () => {
		await expect(
			toolContext.ensureWebsiteAccess(websiteId, {
				apiKey: null,
				oauth: {
					grant: { organizationId, websiteIds: [websiteId] },
					scopes: ["read:data"],
					user: outsider,
				},
				requestHeaders: new Headers(),
				userId: null,
			})
		).rejects.toThrow("Access denied to this website");
	});

	test("keeps a member of several organizations inside the one they consented to", async () => {
		for (const [grantedOrganizationId, expected] of [
			[organizationId, websiteId],
			[otherOrganizationId, otherWebsiteId],
		] as const) {
			const listed = await toolContext.getCachedAccessibleWebsites({
				apiKey: null,
				oauth: {
					grant: { organizationId: grantedOrganizationId, websiteIds: null },
					scopes: ["read:data"],
					user: multiOrg,
				},
				userId: null,
			});
			expect(listed.map((website) => website.id)).toEqual([expected]);
		}
		const outsiderSites = await toolContext.getCachedAccessibleWebsites({
			apiKey: null,
			oauth: {
				grant: { organizationId, websiteIds: null },
				scopes: ["read:data"],
				user: outsider,
			},
			userId: null,
		});
		expect(outsiderSites).toEqual([]);
	});

	test("resolves the consented organization and asks website-limited grants for a website", () => {
		const oauth = {
			grant: { organizationId, websiteIds: null },
			scopes: ["read:data"],
			user: multiOrg,
		};
		expect(
			toolContext.resolveOrganizationId({ apiKey: null, oauth, userId: null })
		).toBe(organizationId);
		expect(() =>
			toolContext.resolveOrganizationId({
				apiKey: null,
				oauth: { ...oauth, grant: { organizationId, websiteIds: [websiteId] } },
				userId: null,
			})
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
	});

	test("denies a user with no membership at all", async () => {
		await expect(
			toolContext.ensureWebsiteAccess(websiteId, {
				apiKey: null,
				oauth: {
					grant: { organizationId, websiteIds: [websiteId] },
					scopes: ["read:data"],
					user: { ...viewer, id: `ghost-${suffix}` },
				},
				requestHeaders: new Headers(),
				userId: null,
			})
		).rejects.toBeInstanceOf(Error);
	});

	test("files MCP feedback under the selected website's organization", async () => {
		const submitAs = (user: typeof viewer) => {
			const tool = mcpTools
				.createMcpTools({
					apiKey: null,
					oauth: {
						grant: { organizationId, websiteIds: [websiteId] },
						scopes: ["read:data"],
						user,
					},
					requestHeaders: new Headers(),
					userId: null,
				})
				.find(({ name }) => name === "submit_feedback");
			if (!tool) {
				throw new Error("submit_feedback is not registered");
			}
			return tool.handler({
				websiteId,
				title: "Export button does nothing",
				description: "Clicking export on the events page shows no file.",
				category: "bug_report",
				errorDetails: "TypeError: blob is undefined",
			});
		};

		const sent = await submitAs(viewer);
		expect(sent.isError).toBe(false);
		const feedbackId = sent.structuredContent?.feedbackId;
		expect(typeof feedbackId).toBe("string");
		const [row] = await dbModule.db
			.select()
			.from(schema.feedback)
			.where(dbModule.eq(schema.feedback.id, String(feedbackId)));
		expect(row).toMatchObject({
			userId: viewerId,
			organizationId,
			websiteId,
			source: "mcp",
			category: "bug_report",
			metadata: { errorDetails: "TypeError: blob is undefined" },
		});

		const denied = await submitAs(outsider);
		expect(denied.isError).toBe(true);
		const outsiderRows = await dbModule.db
			.select({ id: schema.feedback.id })
			.from(schema.feedback)
			.where(dbModule.eq(schema.feedback.userId, outsiderId));
		expect(outsiderRows).toEqual([]);
	});
});
