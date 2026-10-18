import "@databuddy/db/test-env";
import { randomUUID } from "node:crypto";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { db, eq, inArray, shutdownPostgres } from "@databuddy/db";
import { account, member, organization, user } from "@databuddy/db/schema";

const integration =
	process.env.PASSWORD_RESET_INTEGRATION_TESTS === "true"
		? describe
		: describe.skip;

const RESET_LINK_TOKEN = /\/reset-password\/([A-Za-z0-9_-]+)/;
const RESET_CODE = /^(\d{6}) is your Databuddy password reset code$/;

integration("outstanding password resets", () => {
	let auth: typeof import("./oauth").oauthAuth;
	let userId: string;
	let email: string;
	let sentEmails: { html: string; subject: string }[] = [];
	const baseURL = "http://localhost:3001";
	const password = "SyntheticTestPassword123!";

	const call = (path: string, body: unknown, cookie?: string) =>
		auth.handler(
			new Request(`${baseURL}/api/auth${path}`, {
				method: "POST",
				headers: {
					origin: baseURL,
					"content-type": "application/json",
					...(cookie && { cookie }),
				},
				body: JSON.stringify(body),
			})
		);
	const lastEmail = () => sentEmails.at(-1) ?? { html: "", subject: "" };
	const requestResetLink = async () => {
		const response = await call("/request-password-reset", {
			email,
			redirectTo: "/login",
		});
		expect(response.status).toBe(200);
		return RESET_LINK_TOKEN.exec(lastEmail().html)?.[1] ?? "";
	};
	const requestResetCode = async () => {
		const response = await call("/email-otp/send-verification-otp", {
			email,
			type: "forget-password",
		});
		expect(response.status).toBe(200);
		return RESET_CODE.exec(lastEmail().subject)?.[1] ?? "";
	};
	const resetWithLink = (token: string) =>
		call("/reset-password", { token, newPassword: `Reset-${randomUUID()}` });
	const resetWithCode = (otp: string) =>
		call("/email-otp/reset-password", {
			email,
			otp,
			password: `Reset-${randomUUID()}`,
		});

	beforeAll(async () => {
		process.env.RESEND_API_KEY = "re_synthetic_test";
		const realFetch = globalThis.fetch;
		spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.startsWith("https://api.resend.com/")) {
				return realFetch(input, init);
			}
			if (url === "https://api.resend.com/emails") {
				sentEmails.push(JSON.parse(String(init?.body)));
			}
			return Response.json({ id: randomUUID() });
		}) as typeof fetch);
		process.env.BETTER_AUTH_URL = baseURL;
		auth = (await import("./oauth")).oauthAuth;
	});
	beforeEach(async () => {
		sentEmails = [];
		userId = `synthetic-reset-${randomUUID()}`;
		email = `${userId}@example.com`;
		const now = new Date();
		await db.insert(user).values({
			id: userId,
			name: "Synthetic reset user",
			email,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		});
		const context = await auth.$context;
		await db.insert(account).values({
			id: randomUUID(),
			accountId: userId,
			userId,
			providerId: "credential",
			password: await context.password.hash(password),
			createdAt: now,
			updatedAt: now,
		});
	});
	afterEach(async () => {
		const memberships = await db
			.select({ organizationId: member.organizationId })
			.from(member)
			.where(eq(member.userId, userId));
		const organizationIds = memberships.map((row) => row.organizationId);
		if (organizationIds.length) {
			await db
				.delete(organization)
				.where(inArray(organization.id, organizationIds));
		}
		await db.delete(user).where(eq(user.id, userId));
	});
	afterAll(async () => {
		mock.restore();
		Reflect.deleteProperty(process.env, "RESEND_API_KEY");
		await shutdownPostgres();
	});

	test("changing the password invalidates reset links and codes sent before it", async () => {
		const link = await requestResetLink();
		const code = await requestResetCode();
		expect(link).not.toBe("");
		expect(code).not.toBe("");

		const signIn = await call("/sign-in/email", { email, password });
		const cookie = signIn.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const changed = await call(
			"/change-password",
			{ currentPassword: password, newPassword: `Changed-${randomUUID()}` },
			cookie
		);
		expect(changed.status).toBe(200);

		expect((await resetWithLink(link)).status).toBe(400);
		expect((await resetWithCode(code)).status).toBe(400);
	});

	test("finishing one reset invalidates the other outstanding links and codes", async () => {
		const first = await requestResetLink();
		const second = await requestResetLink();
		const code = await requestResetCode();

		expect((await resetWithLink(first)).status).toBe(200);
		expect((await resetWithLink(second)).status).toBe(400);
		expect((await resetWithCode(code)).status).toBe(400);
	});
});
