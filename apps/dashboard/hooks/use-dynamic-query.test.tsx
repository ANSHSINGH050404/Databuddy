import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { DateRange } from "../types/analytics";
import type {
	BatchQueryResponse,
	DynamicQueryRequest,
	DynamicQueryResponse,
} from "../types/api";
import {
	fetchDynamicQuery,
	useBatchDynamicQuery,
	useDynamicQuery,
} from "./use-dynamic-query";

const dateRange: DateRange = {
	start_date: "2026-10-01",
	end_date: "2026-10-07",
};
const request: DynamicQueryRequest = {
	parameters: ["profile_revenue", "profile_detail"],
};
const queryKey = ["dynamic-query", "synthetic-site", dateRange, request];
interface ProfileData extends Record<string, unknown[] | undefined> {
	profile_detail: { visitor_id: string }[];
	profile_revenue: { amount: number }[];
}
let client: QueryClient;
const wasOnline = onlineManager.isOnline();
const originalFetch = globalThis.fetch;
beforeEach(() => {
	client = new QueryClient();
});
afterEach(() => {
	client.clear();
	onlineManager.setOnline(wasOnline);
	globalThis.fetch = originalFetch;
});

const batchRequests = [{ id: "profile", ...request }];
const batchKey = [
	"batch-dynamic-query",
	"synthetic-site",
	undefined,
	undefined,
	undefined,
	dateRange.start_date,
	dateRange.end_date,
	dateRange.granularity,
	dateRange.timezone,
	JSON.stringify(batchRequests),
];

function batch(data: DynamicQueryResponse["data"]): BatchQueryResponse {
	return {
		batch: true,
		success: true,
		results: [{ ...response(data), queryId: "profile" }],
	};
}

function inspectBatch(
	check: (query: ReturnType<typeof useBatchDynamicQuery>) => void
) {
	function Probe() {
		check(
			useBatchDynamicQuery("synthetic-site", dateRange, batchRequests, {
				retryOnMount: false,
			})
		);
		return null;
	}
	renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<Probe />
		</QueryClientProvider>
	);
}

describe("batch dynamic query states", () => {
	it("reports failed parameters and preserves successful peers, then recovers to real empty data", () => {
		client.setQueryData(
			batchKey,
			batch([
				{
					parameter: "profile_revenue",
					success: false,
					data: [],
					error: "Unsupported filter",
				},
				{
					parameter: "profile_detail",
					success: true,
					data: [{ visitor_id: "synthetic-profile" }],
				},
			])
		);
		inspectBatch((query) => {
			expect(query.isError).toBe(true);
			expect(query.error?.message).toBe("Unsupported filter");
			expect(query.results[0]?.error).toBe("Unsupported filter");
			expect(query.getDataForQuery("profile", "profile_detail")).toEqual([
				{ visitor_id: "synthetic-profile" },
			]);
			expect(query.getDataForQuery("profile", "profile_revenue")).toEqual([]);
		});
		client.setQueryData(
			batchKey,
			batch([{ parameter: "profile_revenue", success: true, data: [] }])
		);
		inspectBatch((query) => {
			expect(query.isError).toBe(false);
			expect(query.error).toBeNull();
			expect(query.results[0]?.success).toBe(true);
			expect(query.getDataForQuery("profile", "profile_revenue")).toEqual([]);
		});
	});
	it("exposes a fallback for all failed parameters and preserves cache on transport failure", async () => {
		client.setQueryData(
			batchKey,
			batch([{ parameter: "profile_revenue", success: false, data: [] }])
		);
		inspectBatch((query) => {
			expect(query.isError).toBe(true);
			expect(query.error?.message).toBe("Failed to fetch analytics data");
			expect(query.results[0]?.success).toBe(false);
		});
		client.setQueryData(
			batchKey,
			batch([
				{
					parameter: "profile_revenue",
					success: true,
					data: [{ amount: 125 }],
				},
			])
		);
		await expect(
			client.fetchQuery({
				queryKey: batchKey,
				queryFn: () => Promise.reject(new Error("Synthetic network failure")),
				retry: false,
			})
		).rejects.toThrow("Synthetic network failure");
		inspectBatch((query) => {
			expect(query.isError).toBe(true);
			expect(query.error?.message).toBe("Synthetic network failure");
			expect(query.getDataForQuery("profile", "profile_revenue")).toEqual([
				{ amount: 125 },
			]);
		});
	});
	it("sends the requested site timezone through the HTTP boundary", async () => {
		const requests: URL[] = [];
		globalThis.fetch = (async (input) => {
			requests.push(new URL(String(input)));
			return Response.json(batch([]));
		}) as typeof fetch;
		await fetchDynamicQuery(
			"synthetic-site",
			{ ...dateRange, timezone: "America/Los_Angeles" },
			batchRequests
		);
		expect(requests[0]?.searchParams.get("timezone")).toBe(
			"America/Los_Angeles"
		);
	});
});

function response(data: DynamicQueryResponse["data"]): DynamicQueryResponse {
	return {
		success: true,
		data,
		meta: {
			parameters: data.map((result) => result.parameter),
			total_parameters: data.length,
			page: 1,
			limit: 50,
			filters_applied: 0,
		},
	};
}
const revenue = response([
	{ parameter: "profile_revenue", success: true, data: [{ amount: 125 }] },
]);

function inspect(
	check: (query: ReturnType<typeof useDynamicQuery<ProfileData>>) => void
) {
	function Probe() {
		check(
			useDynamicQuery<ProfileData>("synthetic-site", dateRange, request, {
				retryOnMount: false,
			})
		);
		return null;
	}
	renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<Probe />
		</QueryClientProvider>
	);
}

describe("dynamic query states", () => {
	it("exposes parameter failures while preserving successful results, then recovers", () => {
		client.setQueryData(
			queryKey,
			response([
				{
					parameter: "profile_revenue",
					success: false,
					data: [],
					error: "Synthetic failure",
				},
				{
					parameter: "profile_detail",
					success: true,
					data: [{ visitor_id: "synthetic-profile" }],
				},
			])
		);
		inspect((query) => {
			expect(query.isError).toBe(true);
			expect(query.error?.message).toBe("Synthetic failure");
			expect(query.data.profile_detail?.[0]?.visitor_id).toBe(
				"synthetic-profile"
			);
		});
		client.setQueryData(queryKey, revenue);
		inspect((query) => {
			expect(query.isError).toBe(false);
			expect(query.error).toBeNull();
			expect(query.data.profile_revenue?.[0]?.amount).toBe(125);
		});
	});
	it("distinguishes loading, offline, network failure and successful empty data", async () => {
		inspect((query) => expect(query.isLoading).toBe(true));
		onlineManager.setOnline(false);
		const paused = client
			.fetchQuery({ queryKey, queryFn: () => Promise.resolve(response([])) })
			.catch(() => null);
		inspect((query) => expect(query.isPaused).toBe(true));
		await client.cancelQueries({ queryKey });
		await paused;
		onlineManager.setOnline(true);
		await expect(
			client.fetchQuery({
				queryKey,
				queryFn: () => Promise.reject(new Error("Synthetic network failure")),
				retry: false,
			})
		).rejects.toThrow("Synthetic network failure");
		inspect((query) => {
			expect(query.isError).toBe(true);
			expect(query.error?.message).toBe("Synthetic network failure");
		});
		await client.fetchQuery({
			queryKey,
			queryFn: () =>
				Promise.resolve(
					response([{ parameter: "profile_revenue", success: true, data: [] }])
				),
		});
		inspect((query) => {
			expect(query.isError).toBe(false);
			expect(query.isLoading).toBe(false);
			expect(query.data.profile_revenue).toEqual([]);
		});
	});
	it("preserves cached data during refresh and after a network failure", async () => {
		client.setQueryData(queryKey, revenue);
		const { promise, reject } = Promise.withResolvers<DynamicQueryResponse>();
		const refreshing = client.fetchQuery({
			queryKey,
			queryFn: () => promise,
			retry: false,
		});
		inspect((query) => {
			expect(query.isFetching).toBe(true);
			expect(query.data.profile_revenue?.[0]?.amount).toBe(125);
		});
		reject(new Error("Synthetic refresh failure"));
		await expect(refreshing).rejects.toThrow("Synthetic refresh failure");
		inspect((query) => {
			expect(query.isError).toBe(true);
			expect(query.data.profile_revenue?.[0]?.amount).toBe(125);
		});
	});
});
