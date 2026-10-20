import "@databuddy/test/env";

import { annotations } from "@databuddy/db/schema";
import { appRouter } from "@databuddy/rpc";
import {
	apiKeyContext,
	cleanup,
	db,
	expectCode,
	hasTestDb,
	insertMember,
	insertOrganization,
	insertUser,
	insertWebsite,
	reset,
	userContext,
} from "@databuddy/test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "./helpers";

const iit = hasTestDb ? it : it.skip;

beforeEach(() => reset());
afterAll(() => cleanup());

async function setupAnnotation() {
	const org = await insertOrganization();
	const site = await insertWebsite({ organizationId: org.id });
	const [author, otherMember, admin] = await Promise.all([
		insertUser(),
		insertUser(),
		insertUser(),
	]);
	await Promise.all([
		insertMember({ organizationId: org.id, userId: author.id, role: "member" }),
		insertMember({
			organizationId: org.id,
			userId: otherMember.id,
			role: "member",
		}),
		insertMember({ organizationId: org.id, userId: admin.id, role: "admin" }),
	]);
	const [annotation] = await db()
		.insert(annotations)
		.values({
			id: crypto.randomUUID(),
			websiteId: site.id,
			chartType: "metrics",
			chartContext: {
				dateRange: {
					start_date: "2026-10-01",
					end_date: "2026-10-07",
					granularity: "daily",
				},
			},
			annotationType: "point",
			xValue: new Date("2026-10-03T00:00:00Z"),
			text: "Original note",
			isPublic: false,
			createdBy: author.id,
		})
		.returning();
	const updateAs = (user: Parameters<typeof userContext>[0]) =>
		call(appRouter.annotations.update, userContext(user, org.id));
	const updateWithApiKey = call(
		appRouter.annotations.update,
		apiKeyContext(org.id, ["manage:websites"])
	);
	return {
		id: annotation.id,
		author,
		otherMember,
		admin,
		updateAs,
		updateWithApiKey,
	};
}

describe("annotations.update ownership", () => {
	iit("refuses a member editing another member's annotation", async () => {
		const { id, otherMember, updateAs } = await setupAnnotation();

		await expectCode(
			updateAs(otherMember)({
				id,
				text: "Changed by someone else",
				isPublic: true,
			}),
			"FORBIDDEN"
		);

		const [row] = await db().select().from(annotations);
		expect(row).toMatchObject({ text: "Original note", isPublic: false });
	});

	iit("lets the author, an admin and an API key edit it", async () => {
		const { id, author, admin, updateAs, updateWithApiKey } =
			await setupAnnotation();

		await expect(
			updateAs(author)({ id, text: "Edited by author" })
		).resolves.toMatchObject({ text: "Edited by author" });
		await expect(
			updateAs(admin)({ id, isPublic: true })
		).resolves.toMatchObject({ text: "Edited by author", isPublic: true });
		await expect(
			updateWithApiKey({ id, color: "#EF4444" })
		).resolves.toMatchObject({ color: "#EF4444", isPublic: true });
	});
});
