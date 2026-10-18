import { publicConfig } from "@databuddy/env/public";
import type { DateRange } from "@/types/analytics";
import type {
	BatchQueryResponse,
	DynamicQueryRequest,
	DynamicQueryResponse,
} from "@/types/api";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { guessTimezone } from "@databuddy/ui";

const API_BASE_URL = publicConfig.urls.api;

export const dynamicQueryKeys = {
	all: () => ["dynamic-query"] as const,
	byWebsite: (websiteId: string) => ["dynamic-query", websiteId] as const,
};

export const batchDynamicQueryKeys = {
	all: () => ["batch-dynamic-query"] as const,
	byWebsite: (websiteId: string) => ["batch-dynamic-query", websiteId] as const,
	byTarget: (target: { scheduleId?: string; websiteId?: string }) =>
		["batch-dynamic-query", target.websiteId, target.scheduleId] as const,
};

interface QueryTarget {
	linkId?: string;
	organizationId?: string;
	scheduleId?: string;
	websiteId?: string;
}

const TARGET_PARAM: Record<keyof QueryTarget, string> = {
	linkId: "link_id",
	scheduleId: "schedule_id",
	websiteId: "website_id",
	organizationId: "organization_id",
};

function buildParams(
	target: QueryTarget,
	dateRange: DateRange,
	timezone: string
): URLSearchParams {
	const params = new URLSearchParams({ timezone });

	for (const key of [
		"linkId",
		"scheduleId",
		"websiteId",
		"organizationId",
	] as const) {
		const value = target[key];
		if (value) {
			params.set(TARGET_PARAM[key], value);
			break;
		}
	}

	if (dateRange.start_date) {
		params.append("start_date", dateRange.start_date);
	}
	if (dateRange.end_date) {
		params.append("end_date", dateRange.end_date);
	}
	if (dateRange.granularity) {
		params.append("granularity", dateRange.granularity);
	}

	params.append("_t", Date.now().toString());
	return params;
}

const defaultQueryOptions = {
	staleTime: 2 * 60 * 1000,
	gcTime: 30 * 60 * 1000,
	refetchOnWindowFocus: false,
	refetchOnMount: true,
	refetchInterval: 10 * 60 * 1000,
	retry: (failureCount: number, error: Error) => {
		if (error instanceof DOMException && error.name === "AbortError") {
			return false;
		}
		return failureCount < 2;
	},
	networkMode: "online" as const,
	refetchIntervalInBackground: false,
};

function buildRequest(
	query: DynamicQueryRequest,
	dateRange: DateRange,
	timezone: string
) {
	return {
		...query,
		startDate: dateRange.start_date,
		endDate: dateRange.end_date,
		timeZone: timezone,
		limit: query.limit || 100,
		page: query.page || 1,
		filters: query.filters?.map(({ field, operator, value }) => ({
			field,
			op: operator,
			value,
		})),
		granularity: query.granularity || dateRange.granularity || "daily",
	};
}

export function fetchDynamicQuery(
	idOrOptions: string | QueryTarget,
	dateRange: DateRange,
	queryData: DynamicQueryRequest,
	signal?: AbortSignal
): Promise<DynamicQueryResponse>;
export function fetchDynamicQuery(
	idOrOptions: string | QueryTarget,
	dateRange: DateRange,
	queryData: DynamicQueryRequest[],
	signal?: AbortSignal
): Promise<BatchQueryResponse>;
export async function fetchDynamicQuery(
	idOrOptions: string | QueryTarget,
	dateRange: DateRange,
	queryData: DynamicQueryRequest | DynamicQueryRequest[],
	signal?: AbortSignal
): Promise<DynamicQueryResponse | BatchQueryResponse> {
	const timezone = dateRange.timezone || guessTimezone();
	const target: QueryTarget =
		typeof idOrOptions === "string" ? { websiteId: idOrOptions } : idOrOptions;

	const url = `${API_BASE_URL}/v1/query?${buildParams(target, dateRange, timezone)}`;

	const requestBody = Array.isArray(queryData)
		? queryData.map((q) => buildRequest(q, dateRange, timezone))
		: buildRequest(queryData, dateRange, timezone);

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		signal,
		body: JSON.stringify(requestBody),
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch dynamic query data: ${response.statusText}`
		);
	}

	const data = await response.json();
	if (!data.success) {
		throw new Error(data.error || "Failed to fetch dynamic query data");
	}
	return data;
}

export function useDynamicQuery<
	TData extends Record<string, unknown[] | undefined> = Record<
		string,
		Record<string, unknown>[] | undefined
	>,
>(
	websiteId: string,
	dateRange: DateRange,
	queryData: DynamicQueryRequest,
	options?: Partial<UseQueryOptions<DynamicQueryResponse>>
) {
	const query = useQuery({
		queryKey: ["dynamic-query", websiteId, dateRange, queryData],
		queryFn: ({ signal }) =>
			fetchDynamicQuery(websiteId, dateRange, queryData, signal),
		...defaultQueryOptions,
		...options,
		enabled:
			options?.enabled !== false &&
			!!websiteId &&
			queryData.parameters.length > 0,
	});

	const processedData = useMemo(
		() =>
			Object.fromEntries(
				(query.data?.data ?? [])
					.filter((result) => result.success)
					.map((result) => [result.parameter, result.data])
			) as TData,
		[query.data]
	);
	const failedResult = query.data?.data.find((result) => !result.success);

	return {
		data: processedData,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		isPaused: query.isPaused,
		isError: query.isError || Boolean(failedResult),
		error:
			query.error ??
			(failedResult
				? new Error(failedResult.error || "Failed to fetch analytics data")
				: null),
		refetch: query.refetch,
	};
}

export function useBatchDynamicQuery(
	idOrOptions: string | QueryTarget,
	dateRange: DateRange,
	queries: DynamicQueryRequest[],
	options?: Partial<UseQueryOptions<BatchQueryResponse>>
) {
	const target: QueryTarget =
		typeof idOrOptions === "string" ? { websiteId: idOrOptions } : idOrOptions;

	const query = useQuery({
		queryKey: [
			"batch-dynamic-query",
			target.websiteId,
			target.scheduleId,
			target.linkId,
			target.organizationId,
			dateRange.start_date,
			dateRange.end_date,
			dateRange.granularity,
			dateRange.timezone,
			JSON.stringify(queries),
		],
		queryFn: ({ signal }) =>
			fetchDynamicQuery(target, dateRange, queries, signal),
		...defaultQueryOptions,
		...options,
		enabled:
			options?.enabled !== false &&
			(!!target.websiteId ||
				!!target.scheduleId ||
				!!target.linkId ||
				!!target.organizationId) &&
			queries.length > 0,
	});

	const processedResults = useMemo(
		() =>
			(query.data?.results ?? []).map((result) => {
				const failure = result.data.find((parameter) => !parameter.success);
				const data: Record<string, unknown[]> = Object.fromEntries(
					result.data
						.filter((parameter) => parameter.success)
						.map((parameter) => [parameter.parameter, parameter.data])
				);
				return {
					queryId: result.queryId,
					success: result.data.some((parameter) => parameter.success),
					data,
					error:
						result.error ||
						(failure && (failure.error || "Failed to fetch analytics data")),
				};
			}),
		[query.data]
	);
	const failure = processedResults.find((result) => result.error);

	const getDataForQuery = useCallback(
		<T extends object = Record<string, unknown>>(
			queryId: string,
			parameter: string
		): T[] => {
			const result = processedResults.find((r) => r.queryId === queryId);
			return (result?.data[parameter] as T[] | undefined) ?? [];
		},
		[processedResults]
	);

	return {
		results: processedResults,
		isLoading: query.isLoading,
		isError: query.isError || Boolean(failure),
		error: query.error ?? (failure ? new Error(failure.error) : null),
		refetch: query.refetch,
		isFetching: query.isFetching,
		isPending: query.isPending,
		isPlaceholderData: query.isPlaceholderData,
		getDataForQuery,
	};
}
