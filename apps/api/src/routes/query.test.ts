import type { User } from "@databuddy/auth";
import type { CompiledQuery } from "@databuddy/ai/query/types";
import type { profiles, websites } from "@databuddy/db/schema";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicQueryRequestType } from "../schemas/query-schemas";

const state = vi.hoisted(() => ({
	user: null as Pick<User, "id" | "name" | "email"> | null,
	website: null as Pick<
		typeof websites.$inferSelect,
		"id" | "isPublic" | "organizationId"
	> | null,
	member: true,
	queries: [] as {
		sql: string;
		params: CompiledQuery["params"];
		label?: string;
	}[],
	traitQueries: [] as { sql: string; params: unknown[] }[],
	segment: ["synthetic-profile"],
	identities: [] as Pick<
		typeof profiles.$inferSelect,
		"profileId" | "displayName" | "email"
	>[],
	rows: {} as Record<string, Record<string, unknown>[]>,
	failLabel: "",
	domainError: false,
	planError: null as string | null,
	rateAllowed: true,
}));

vi.mock("@databuddy/auth", () => ({
	auth: { api: { getSession: async () => state.user && { user: state.user } } },
}));
vi.mock("../lib/auth-wide-event", () => ({ getResolvedAuth: () => undefined }));
vi.mock("@databuddy/api-keys/resolve", () => ({
	API_KEY_AUTH_CHALLENGE: "Bearer",
	isApiKeyPresent: () => false,
	getApiKeyFromHeader: async () => null,
	hasGlobalAccess: () => false,
	hasKeyAnyScope: () => false,
	hasKeyScope: () => false,
	hasWebsiteScope: () => false,
	hasWebsiteScopeForOrganization: () => false,
	getAccessibleWebsiteIds: () => [],
}));
vi.mock("@databuddy/db", async () => {
	const orm = await import("drizzle-orm");
	const schema = await import("@databuddy/db/schema");
	const { PgDialect } = await import("drizzle-orm/pg-core");
	const dialect = new PgDialect();
	return {
		...orm,
		...schema,
		db: {
			query: {
				websites: {
					findFirst: async () => state.website,
					findMany: async () => [{ id: "synthetic-site" }],
				},
				member: {
					findFirst: async () => (state.member ? { id: "member" } : null),
				},
			},
			select: (fields: Record<string, unknown>) => ({
				from: () => ({
					where: (condition: SQL) => {
						const compiled = dialect.sqlToQuery(condition);
						if ("displayName" in fields) {
							return Promise.resolve(state.identities);
						}
						state.traitQueries.push(compiled);
						return {
							limit: async () =>
								state.segment.map((profileId) => ({ profileId })),
						};
					},
				}),
			}),
		},
	};
});
vi.mock("@databuddy/db/clickhouse", async () => ({
	...(await import("../../../../packages/db/src/clickhouse/identity")),
	...(await import("../../../../packages/db/src/clickhouse/revenue")),
	chQuery: async (
		sql: string,
		params: CompiledQuery["params"],
		options?: { label?: string }
	) => {
		state.queries.push({ sql, params, label: options?.label });
		if (options?.label === state.failLabel) {
			throw new Error(
				"SELECT private_column FROM synthetic_secret: SQL syntax error"
			);
		}
		return state.rows[options?.label ?? ""] ?? [{ pageviews: 7 }];
	},
}));
vi.mock("@databuddy/ai/query", async () => ({
	...(await import("../../../../packages/ai/src/query/batch-executor")),
	...(await import("../../../../packages/ai/src/query/trait-filters")),
	allowedFilterFields: (
		await import("../../../../packages/ai/src/query/simple-builder")
	).allowedFilterFields,
	compileQuery: vi.fn(),
	queryPlanGateError: async () => state.planError,
}));
vi.mock("@databuddy/ai/lib/website-utils", () => ({
	getWebsiteDomain: async () => {
		if (state.domainError) {
			throw new Error("synthetic lookup failed");
		}
		return "synthetic.example.test";
	},
}));
vi.mock("@databuddy/ai/lib/accessible-websites", () => ({
	getAccessibleWebsites: async () => [],
}));
vi.mock("@databuddy/ai/lib/tracing", () => ({
	captureError: () => {},
	captureWarning: () => {},
	mergeWideEvent: () => {},
}));
vi.mock("@databuddy/redis/rate-limit", () => ({
	ratelimit: async () => ({
		success: state.rateAllowed,
		limit: 60,
		remaining: 0,
		reset: Date.now() + 60_000,
	}),
	getRateLimitHeaders: () => ({}),
}));

const { query } = await import("./query");
const base = {
	parameters: ["summary_metrics"],
	startDate: "2026-10-01",
	endDate: "2026-10-02",
} satisfies DynamicQueryRequestType;

function post(
	body: DynamicQueryRequestType | DynamicQueryRequestType[],
	search = "website_id=synthetic-site"
) {
	return query.handle(
		new Request(`http://localhost/v1/query/?${search}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
	);
}

beforeEach(() => {
	state.user = {
		id: "synthetic-user",
		name: "Synthetic user",
		email: "user@example.test",
	};
	state.website = {
		id: "synthetic-site",
		isPublic: false,
		organizationId: "synthetic-org",
	};
	state.member = true;
	state.queries = [];
	state.traitQueries = [];
	state.segment = ["synthetic-profile"];
	state.identities = [];
	state.rows = {};
	state.failLabel = "";
	state.domainError = false;
	state.planError = null;
	state.rateAllowed = true;
});
afterEach(() => vi.useRealTimers());

describe("query HTTP boundary with the shared executor", () => {
	it("rejects an unsupported filter without broadening it, preserving a valid peer", async () => {
		const response = await post({
			...base,
			parameters: [
				"custom_events_trends",
				{ name: "summary_metrics", id: "overview" },
			],
			filters: [{ field: "country", op: "eq", value: "JO" }],
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.data).toEqual([
			{ parameter: "overview", success: true, data: [{ pageviews: 7 }] },
			{
				parameter: "custom_events_trends",
				success: false,
				data: [],
				error: expect.stringContaining(
					"Filter on field 'country' is not permitted"
				),
			},
		]);
		expect(body.meta.filters_applied).toBe(1);
		expect(state.queries).toHaveLength(1);
		expect(state.queries[0]?.sql).toContain("country = {");
		expect(Object.values(state.queries[0]?.params ?? {})).toContain("JO");
	});

	it("reports no applied filters when every parameter is unavailable", async () => {
		const response = await post({
			...base,
			parameters: ["custom_events_trends"],
			filters: [{ field: "country", op: "eq", value: "JO" }],
		});
		expect((await response.json()).meta.filters_applied).toBe(0);
		expect(state.queries).toHaveLength(0);
	});

	it.each([
		undefined,
		"UTC",
		"Asia/Amman",
		"invalid/timezone",
	])("uses validated body timezone %s for preset dates and SQL", async (timeZone) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-01T22:30:00Z"));
		const response = await post({
			parameters: ["summary_metrics"],
			preset: "today",
			timeZone,
		});
		expect(response.status).toBe(200);
		expect(state.queries[0]?.params).toMatchObject({
			timezone: timeZone === "Asia/Amman" ? "Asia/Amman" : "UTC",
			startDate:
				timeZone === "Asia/Amman"
					? "2026-10-02 00:00:00"
					: "2026-10-01 00:00:00",
			endDate:
				timeZone === "Asia/Amman"
					? "2026-10-02 23:59:59"
					: "2026-10-01 23:59:59",
		});
	});

	it("lets an explicit URL timezone override a single body's UTC timezone", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-01T22:30:00Z"));
		await post(
			{ parameters: ["summary_metrics"], preset: "today", timeZone: "UTC" },
			"website_id=synthetic-site&timezone=Asia/Amman"
		);
		expect(state.queries[0]?.params).toMatchObject({
			timezone: "Asia/Amman",
			startDate: "2026-10-02 00:00:00",
		});
	});

	it.each([
		undefined,
		"UTC",
		"Asia/Amman",
		"invalid/timezone",
	])("resolves each batch item's timezone with explicit URL precedence: %s", async (urlTimezone) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-01T22:30:00Z"));
		const response = await post(
			[
				{
					id: "utc",
					parameters: ["summary_metrics"],
					preset: "today",
					timeZone: "UTC",
				},
				{
					id: "amman",
					parameters: ["summary_metrics"],
					preset: "today",
					timeZone: "Asia/Amman",
				},
			],
			`website_id=synthetic-site${urlTimezone ? `&timezone=${urlTimezone}` : ""}`
		);
		const body = await response.json();
		expect(
			body.results.map((result: { queryId: string }) => result.queryId)
		).toEqual(["utc", "amman"]);
		expect(
			state.queries.map(({ params }) => [params.timezone, params.startDate])
		).toEqual(
			urlTimezone === "Asia/Amman"
				? [
						["Asia/Amman", "2026-10-02 00:00:00"],
						["Asia/Amman", "2026-10-02 00:00:00"],
					]
				: urlTimezone
					? [
							["UTC", "2026-10-01 00:00:00"],
							["UTC", "2026-10-01 00:00:00"],
						]
					: [
							["UTC", "2026-10-01 00:00:00"],
							["Asia/Amman", "2026-10-02 00:00:00"],
						]
		);
	});

	it("resolves traits once in their website scope and rejects an incompatible peer", async () => {
		const response = await post({
			...base,
			parameters: ["summary_metrics", "custom_events_trends", "session_events"],
			filters: [{ field: "trait:plan", op: "eq", value: "pro" }],
		});
		const body = await response.json();
		expect(body.data[0]).toMatchObject({
			parameter: "summary_metrics",
			success: true,
		});
		expect(body.data[1]).toMatchObject({
			parameter: "custom_events_trends",
			success: true,
		});
		expect(body.data[2]).toMatchObject({
			parameter: "session_events",
			success: false,
			error: expect.stringContaining("Trait filters are not supported"),
		});
		expect(state.traitQueries).toHaveLength(1);
		expect(state.traitQueries[0]?.params).toEqual([
			"synthetic-site",
			"plan",
			"pro",
		]);
		expect(state.traitQueries[0]?.sql).toContain('"profiles"."website_id"');
		expect(state.queries).toHaveLength(2);
		for (const { params } of state.queries) {
			expect(Object.values(params)).toContainEqual(["synthetic-profile"]);
		}
	});

	it("preserves an empty trait population and exposes native trait validation failures", async () => {
		state.segment = [];
		await post({
			...base,
			filters: [{ field: "trait:plan", op: "eq", value: "pro" }],
		});
		expect(Object.values(state.queries[0]?.params ?? {})).toContainEqual([]);
		const response = await post({
			...base,
			filters: [{ field: "trait:plan", op: "contains", value: "pro" }],
		});
		expect((await response.json()).data[0]).toMatchObject({
			success: false,
			error: "Trait filters do not support the contains operator.",
		});
	});

	it("keeps organization custom-event owner scoping and refuses organization trait filters", async () => {
		await post(
			{ ...base, parameters: ["custom_events_trends"] },
			"organization_id=synthetic-org"
		);
		expect(state.queries[0]?.sql).toContain("owner_id = {projectId:String}");
		expect(state.queries[0]?.params.projectId).toBe("synthetic-org");
		const response = await post(
			{ ...base, filters: [{ field: "trait:plan", op: "eq", value: "pro" }] },
			"organization_id=synthetic-org"
		);
		expect((await response.json()).data[0]).toMatchObject({
			success: false,
			error: "Trait filters are only supported for website queries",
		});
		expect(state.traitQueries).toHaveLength(0);
	});

	it("sanitizes warehouse failures while retaining successful batch peers", async () => {
		state.failLabel = "custom_events_trends";
		const response = await post([
			{ ...base, id: "failed", parameters: ["custom_events_trends"] },
			{ ...base, id: "valid" },
		]);
		const body = await response.json();
		expect(body.results[0].data[0]).toMatchObject({
			parameter: "custom_events_trends",
			success: false,
			error: "Query failed",
		});
		expect(body.results[1].data[0]).toMatchObject({
			parameter: "summary_metrics",
			success: true,
			data: [{ pageviews: 7 }],
		});
		expect(JSON.stringify(body)).not.toContain("synthetic_secret");
	});

	it("returns each original parameter ID when request preparation fails", async () => {
		state.domainError = true;
		const response = await post({
			...base,
			parameters: [
				{ name: "summary_metrics", id: "one" },
				{ name: "custom_events_trends", id: "two" },
			],
		});
		expect((await response.json()).data).toEqual(
			["one", "two"].map((parameter) => ({
				parameter,
				success: false,
				error: "Query execution failed",
				data: [],
			}))
		);
	});

	it("still decorates profile-list rows with protected website identities", async () => {
		state.rows.profile_list = [
			{ profile_id: "synthetic-profile", session_count: 2 },
		];
		state.identities = [
			{
				profileId: "synthetic-profile",
				displayName: "Synthetic name",
				email: "synthetic@example.test",
			},
		];
		const response = await post({ ...base, parameters: ["profile_list"] });
		expect((await response.json()).data[0].data).toEqual([
			{
				profile_id: "synthetic-profile",
				session_count: 2,
				display_name: "Synthetic name",
				email: "synthetic@example.test",
			},
		]);
	});

	it.each([
		"anonymous",
		"nonmember",
		"missing",
	])("denies %s access before compiling queries", async (access) => {
		if (access === "anonymous") {
			state.user = null;
		}
		if (access === "nonmember") {
			state.member = false;
		}
		if (access === "missing") {
			state.website = null;
		}
		const response = await post(base);
		expect(response.status).toBe(access === "anonymous" ? 401 : 403);
		expect(state.queries).toHaveLength(0);
	});

	it("retains public overview access while protecting profile queries", async () => {
		state.user = null;
		state.website = {
			id: "synthetic-site",
			isPublic: true,
			organizationId: "synthetic-org",
		};
		expect((await post(base)).status).toBe(200);
		expect((await post({ ...base, parameters: ["profile_list"] })).status).toBe(
			401
		);
		expect(state.queries).toHaveLength(1);
	});

	it.each([
		"rate",
		"plan",
	])("retains the %s gate before execution", async (gate) => {
		state.rateAllowed = gate !== "rate";
		state.planError =
			gate === "plan" ? "Synthetic plan does not include this feature" : null;
		expect((await post(base)).status).toBe(gate === "rate" ? 429 : 402);
		expect(state.queries).toHaveLength(0);
	});
});
