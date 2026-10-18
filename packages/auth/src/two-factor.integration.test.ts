import "@databuddy/db/test-env";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { and, db, eq, inArray, shutdownPostgres } from "@databuddy/db";
import {
	account,
	auditEvents,
	member,
	organization,
	twoFactor,
	user,
	websites,
} from "@databuddy/db/schema";
import { getRedisCache } from "@databuddy/redis";
import { symmetricDecrypt } from "better-auth/crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const fail = (): never => {
	throw new Error("Expected the synthetic account");
};

const integration =
	process.env.TWO_FACTOR_INTEGRATION_TESTS === "true"
		? describe
		: describe.skip;

integration("two-factor sign-in", () => {
	let auth: typeof import("./oauth").oauthAuth;
	let mcpResource: string;
	let twoFactorPagePath: string;
	let userId: string;
	let email: string;
	let backupCodes: string[];
	let sentEmails: { to: string | string[]; subject: string }[] = [];
	const baseURL = "http://localhost:3001";
	const password = "SyntheticTestPassword123!";

	const call = (path: string, init: { body?: unknown; cookie?: string } = {}) =>
		auth.handler(
			new Request(`${baseURL}/api/auth${path}`, {
				method: init.body === undefined ? "GET" : "POST",
				headers: {
					origin: baseURL,
					"content-type": "application/json",
					...(init.cookie && { cookie: init.cookie }),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			})
		);
	const cookiesFrom = (response: Response) =>
		response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0] ?? "")
			.filter((pair) => !pair.endsWith("="))
			.join("; ");
	const sessionUserId = async (cookie: string) => {
		const response = await call("/get-session", { cookie });
		const body = (await response.json()) as { user?: { id: string } } | null;
		return body?.user?.id ?? null;
	};
	const totpCode = async () => {
		const row = await db.query.twoFactor.findFirst({ where: { userId } });
		const context = await auth.$context;
		const secret = await symmetricDecrypt({
			key: context.secretConfig,
			data: row?.secret ?? "",
		});
		return (await auth.api.generateTOTP({ body: { secret } })).code;
	};
	const passwordChallenge = async () => {
		const response = await call("/sign-in/email", {
			body: { email, password },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			twoFactorRedirect: true,
			twoFactorMethods: ["totp"],
		});
		const cookie = cookiesFrom(response);
		expect(await sessionUserId(cookie)).toBeNull();
		return cookie;
	};
	const twoFactorEnabled = async () =>
		(await db.query.user.findFirst({ where: { id: userId } }))
			?.twoFactorEnabled;
	const ownedOrganization = async () => {
		const [owned] = await db
			.select({ organizationId: member.organizationId })
			.from(member)
			.where(and(eq(member.userId, userId), eq(member.role, "owner")));
		return owned?.organizationId ?? fail();
	};
	const website = async (
		organizationId: string,
		createdAt: Date,
		domainChange?: { actorId: string; at: Date }
	) => {
		const id = randomUUID();
		const domain = `${id}.example.com`;
		await db.insert(websites).values({ id, domain, organizationId, createdAt });
		if (domainChange) {
			await db.insert(auditEvents).values({
				id: randomUUID(),
				organizationId,
				action: "website.updated",
				source: "orpc",
				actorType: "user",
				actorId: domainChange.actorId,
				targetType: "website",
				targetId: id,
				changes: { domain: { after: domain } },
				createdAt: domainChange.at,
			});
		}
		return domain;
	};
	const magicLink = async (callbackURL: string) => {
		const token = randomUUID();
		const context = await auth.$context;
		await context.internalAdapter.createVerificationValue({
			identifier: `magic-link:${token}`,
			value: JSON.stringify({ type: "magic-link", email }),
			expiresAt: new Date(Date.now() + 60_000),
		});
		return call(
			`/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(callbackURL)}`
		);
	};

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
		twoFactorPagePath = (await import("./auth")).TWO_FACTOR_PAGE_PATH;
		mcpResource = (await import("@databuddy/env/app")).config.urls.mcp;
	});
	beforeEach(async () => {
		sentEmails = [];
		userId = `synthetic-2fa-${randomUUID()}`;
		email = `${userId}@example.com`;
		const now = new Date();
		await db.insert(user).values({
			id: userId,
			name: "Synthetic two-factor user",
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

		const signIn = await call("/sign-in/email", { body: { email, password } });
		const cookie = cookiesFrom(signIn);
		const enable = await call("/two-factor/enable", {
			body: { password },
			cookie,
		});
		expect(enable.status).toBe(200);
		backupCodes = ((await enable.json()) as { backupCodes: string[] })
			.backupCodes;
		const verify = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie,
		});
		expect(verify.status).toBe(200);
		const enrolled = await db.query.user.findFirst({ where: { id: userId } });
		expect(enrolled?.twoFactorEnabled).toBe(true);
	});
	afterEach(async () => {
		const memberships = await db
			.select({ organizationId: member.organizationId })
			.from(member)
			.where(eq(member.userId, userId));
		const organizationIds = memberships.map((row) => row.organizationId);
		if (organizationIds.length) {
			await db
				.delete(auditEvents)
				.where(inArray(auditEvents.organizationId, organizationIds));
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

	test("password sign-in creates a session only after a valid authenticator code", async () => {
		const challenge = await passwordChallenge();

		const wrong = await call("/two-factor/verify-totp", {
			body: { code: (await totpCode()) === "000000" ? "111111" : "000000" },
			cookie: challenge,
		});
		expect(wrong.status).toBe(401);

		const verified = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: challenge,
		});
		expect(verified.status).toBe(200);
		expect(await sessionUserId(cookiesFrom(verified))).toBe(userId);
	});

	test("turning on, changing, and turning off two-factor emails the account owner, but signing in does not", async () => {
		const verified = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: await passwordChallenge(),
		});
		const cookie = cookiesFrom(verified);
		const regenerated = await call("/two-factor/generate-backup-codes", {
			body: { password },
			cookie,
		});
		expect(regenerated.status).toBe(200);
		const disabled = await call("/two-factor/disable", {
			body: { password },
			cookie,
		});
		expect(disabled.status).toBe(200);

		expect(sentEmails.map(({ to, subject }) => ({ to, subject }))).toEqual(
			[
				"Two-factor authentication is on for your Databuddy account",
				"New backup codes were created for your Databuddy account",
				"Two-factor authentication was turned off for your Databuddy account",
			].map((subject) => ({ to: email, subject }))
		);
	});

	test("an MCP connection reaches consent only after the second factor", async () => {
		const setup = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: await passwordChallenge(),
		});
		const { client_id: clientId } = await auth.api.adminCreateOAuthClient({
			headers: { cookie: cookiesFrom(setup) },
			body: {
				client_name: "Two-factor MCP client",
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
		});
		const authorizeQuery = new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			redirect_uri: "https://claude.ai/api/mcp/auth_callback",
			code_challenge: createHash("sha256")
				.update(randomBytes(32).toString("base64url"))
				.digest("base64url"),
			code_challenge_method: "S256",
			scope: "read:data",
			resource: mcpResource,
		});
		const authorize = (cookie?: string) =>
			auth.handler(
				new Request(`${baseURL}/api/auth/oauth2/authorize?${authorizeQuery}`, {
					headers: { origin: baseURL, ...(cookie && { cookie }) },
				})
			);

		const login = new URL(
			(await authorize()).headers.get("location") ?? "",
			baseURL
		);
		expect(login.pathname).toBe("/login");
		const signIn = await call("/sign-in/email", {
			body: { email, password, oauth_query: login.search.slice(1) },
		});
		expect(await signIn.json()).toEqual({
			twoFactorRedirect: true,
			twoFactorMethods: ["totp"],
		});
		expect(signIn.headers.get("location")).toBeNull();
		expect(await sessionUserId(cookiesFrom(signIn))).toBeNull();

		const verified = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: cookiesFrom(signIn),
		});
		expect(verified.status).toBe(200);
		const consent = new URL(
			(await authorize(cookiesFrom(verified))).headers.get("location") ?? "",
			baseURL
		);
		expect(consent.pathname).toBe("/consent");
	});

	test("turning two-factor off and on again stops trusting browsers trusted before", async () => {
		const onlyTrust = (cookies: string) =>
			cookies
				.split("; ")
				.filter((pair) => pair.includes("trust_device="))
				.join("; ");
		const trusted = await call("/two-factor/verify-totp", {
			body: { code: await totpCode(), trustDevice: true },
			cookie: await passwordChallenge(),
		});
		const skipped = await call("/sign-in/email", {
			body: { email, password },
			cookie: onlyTrust(cookiesFrom(trusted)),
		});
		expect(await sessionUserId(cookiesFrom(skipped))).toBe(userId);
		const trustCookie = onlyTrust(cookiesFrom(skipped));
		expect(trustCookie).not.toBe("");

		const disabled = await call("/two-factor/disable", {
			body: { password },
			cookie: cookiesFrom(skipped)
				.split("; ")
				.filter((pair) => !pair.includes("trust_device="))
				.join("; "),
		});
		expect(disabled.status).toBe(200);
		await call("/two-factor/enable", {
			body: { password },
			cookie: cookiesFrom(disabled),
		});
		const enrolled = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: cookiesFrom(disabled),
		});
		expect(enrolled.status).toBe(200);

		const signIn = await call("/sign-in/email", {
			body: { email, password },
			cookie: trustCookie,
		});
		expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
	});

	test("turning on two-factor signs the account out everywhere else, including sessions missing from Redis", async () => {
		await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
		await db
			.update(user)
			.set({ twoFactorEnabled: false })
			.where(eq(user.id, userId));
		const signIn = async () =>
			cookiesFrom(await call("/sign-in/email", { body: { email, password } }));
		const laptop = await signIn();
		const phone = (await signIn())
			.split("; ")
			.filter((pair) => pair.includes("session_token="))
			.join("; ");
		const phoneToken = decodeURIComponent(phone.split("=")[1] ?? "").split(
			"."
		)[0];
		await getRedisCache().del(`ba:${phoneToken}`);
		expect(await sessionUserId(phone)).toBe(userId);
		const { internalAdapter } = await auth.$context;
		expect(
			(await internalAdapter.listSessions(userId)).map(({ token }) => token)
		).not.toContain(phoneToken);

		await call("/two-factor/enable", { body: { password }, cookie: laptop });
		const enrolled = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: laptop,
		});
		expect(enrolled.status).toBe(200);

		expect(await sessionUserId(cookiesFrom(enrolled))).toBe(userId);
		expect(await sessionUserId(phone)).toBeNull();
	});

	test("account recovery accepts only a settled domain the user set, after the waiting period, once every session is gone", async () => {
		const { completeRecovery, findRecoveryAccount, openRecovery } =
			await import("./two-factor-recovery");
		const ownedOrganizationId = await ownedOrganization();
		const otherOrganizationId = `synthetic-2fa-org-${randomUUID()}`;
		await db.insert(organization).values({
			id: otherOrganizationId,
			name: "Someone else's organization",
			createdAt: daysAgo(90),
		});
		await db.insert(member).values({
			id: randomUUID(),
			organizationId: otherOrganizationId,
			userId,
			role: "member",
			createdAt: daysAgo(90),
		});
		const settled = await website(ownedOrganizationId, daysAgo(60));
		const changedRecently = await website(ownedOrganizationId, daysAgo(60), {
			actorId: userId,
			at: daysAgo(5),
		});
		const setBySomeoneElse = await website(ownedOrganizationId, daysAgo(60), {
			actorId: "synthetic-co-member",
			at: daysAgo(45),
		});
		const notOwned = await website(otherOrganizationId, daysAgo(60));

		const request = async (domain: string) => ({
			account: (await findRecoveryAccount(email)) ?? fail(),
			domain,
			operator: "synthetic-operator",
			ticket: "SYN-1",
		});
		await expect(openRecovery(await request(settled))).rejects.toThrow(
			"still signed in"
		);
		const { internalAdapter } = await auth.$context;
		await internalAdapter.deleteUserSessions(userId);

		await expect(openRecovery(await request(notOwned))).rejects.toThrow(
			"not a website in an organization this account owns"
		);
		await expect(openRecovery(await request(changedRecently))).rejects.toThrow(
			"changed in the last 30 days"
		);
		await expect(openRecovery(await request(setBySomeoneElse))).rejects.toThrow(
			"Someone other than this account"
		);

		sentEmails = [];
		const opened = await openRecovery(await request(settled));
		expect(opened.recordName).toBe(`_databuddy-recovery.${settled}`);
		const published = {
			resolveAlias: () => Promise.resolve([] as string[]),
			resolveText: (name: string) =>
				Promise.resolve(
					name === opened.recordName ? [[opened.recordValue]] : []
				),
		};
		const afterWaiting = new Date(Date.now() + 49 * 60 * 60 * 1000);
		await expect(
			completeRecovery(await request(settled), published)
		).rejects.toThrow("waiting period ends");
		await expect(
			completeRecovery(await request(settled), {
				...published,
				now: afterWaiting,
				resolveAlias: () => Promise.resolve(["attacker.example.net"]),
			})
		).rejects.toThrow("is a CNAME");
		expect(await twoFactorEnabled()).toBe(true);

		expect(
			await completeRecovery(await request(settled), {
				...published,
				now: afterWaiting,
			})
		).toEqual({ notified: true });
		expect(await twoFactorEnabled()).toBe(false);
		expect(
			await db.query.twoFactor.findFirst({ where: { userId } })
		).toBeUndefined();
		expect(sentEmails.map(({ subject }) => subject)).toEqual([
			"Someone asked to reset two-factor authentication on your Databuddy account",
			"Two-factor authentication was reset for your Databuddy account",
		]);
		const audit = await db
			.select({ action: auditEvents.action, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.organizationId, ownedOrganizationId),
					eq(auditEvents.targetId, userId)
				)
			)
			.orderBy(auditEvents.createdAt);
		expect(audit).toEqual([
			...Array.from({ length: 4 }, () => ({
				action: "account.two_factor_recovery_requested",
				outcome: "failure" as const,
			})),
			{ action: "account.two_factor_recovery_requested", outcome: "success" },
			{ action: "account.two_factor_recovered", outcome: "failure" },
			{ action: "account.two_factor_recovered", outcome: "failure" },
			{ action: "account.two_factor_recovered", outcome: "success" },
		]);
	});

	test("recovery without a website needs a second operator and a signed token", async () => {
		const { completeRecovery, findRecoveryAccount, openRecovery } =
			await import("./two-factor-recovery");
		const { internalAdapter } = await auth.$context;
		await internalAdapter.deleteUserSessions(userId);
		const request = async (approvedBy?: string, token?: string) => ({
			account: (await findRecoveryAccount(email)) ?? fail(),
			approvedBy,
			domain: null,
			operator: "synthetic-operator",
			ticket: "SYN-2",
			token,
		});

		await expect(openRecovery(await request())).rejects.toThrow(
			"second operator"
		);
		await expect(
			openRecovery(await request("synthetic-operator"))
		).rejects.toThrow("second operator");
		const opened = await openRecovery(await request("synthetic-approver"));
		expect(opened.recordName).toBeNull();
		const token = opened.recordValue.replace("databuddy-recovery=", "");
		const afterWaiting = {
			now: new Date(Date.now() + 49 * 60 * 60 * 1000),
		};

		await expect(
			completeRecovery(
				await request("synthetic-approver", `${token.split(".")[0]}.forged`),
				afterWaiting
			)
		).rejects.toThrow("not valid");
		await expect(
			completeRecovery(
				{ ...(await request("synthetic-approver", token)), ticket: "SYN-3" },
				afterWaiting
			)
		).rejects.toThrow("not valid");
		await completeRecovery(
			await request("synthetic-approver", token),
			afterWaiting
		);
		expect(await twoFactorEnabled()).toBe(false);
	});

	test("a backup code completes sign-in exactly once", async () => {
		const [code] = backupCodes;
		const first = await call("/two-factor/verify-backup-code", {
			body: { code },
			cookie: await passwordChallenge(),
		});
		expect(first.status).toBe(200);
		expect(await sessionUserId(cookiesFrom(first))).toBe(userId);

		const reused = await call("/two-factor/verify-backup-code", {
			body: { code },
			cookie: await passwordChallenge(),
		});
		expect(reused.status).toBe(401);
	});

	test("a magic link sends a two-factor user to the code page with their destination", async () => {
		const response = await magicLink("/websites?tab=traffic");
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.pathname).toBe(twoFactorPagePath);
		expect(location.searchParams.get("callback")).toBe("/websites?tab=traffic");

		const challenge = cookiesFrom(response);
		expect(await sessionUserId(challenge)).toBeNull();
		const verified = await call("/two-factor/verify-totp", {
			body: { code: await totpCode() },
			cookie: challenge,
		});
		expect(verified.status).toBe(200);
		expect(await sessionUserId(cookiesFrom(verified))).toBe(userId);
	});

	test("an emailed sign-in code asks a two-factor user for the second factor", async () => {
		const context = await auth.$context;
		await context.internalAdapter.createVerificationValue({
			identifier: `sign-in-otp-${email}`,
			value: "123456:0",
			expiresAt: new Date(Date.now() + 60_000),
		});
		const response = await call("/sign-in/email-otp", {
			body: { email, otp: "123456" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
		expect(await sessionUserId(cookiesFrom(response))).toBeNull();
	});

	test("a magic link still signs in a user without two-factor directly", async () => {
		await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
		await db
			.update(user)
			.set({ twoFactorEnabled: false })
			.where(eq(user.id, userId));

		const response = await magicLink("/websites");
		expect(response.status).toBe(302);
		expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
			"/websites"
		);
		expect(await sessionUserId(cookiesFrom(response))).toBe(userId);
	});
});
