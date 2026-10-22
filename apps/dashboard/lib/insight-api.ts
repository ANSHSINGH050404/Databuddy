import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { orpc } from "@/lib/orpc";

const INSIGHT_CACHE = {
	gcTime: 30 * 60 * 1000,
	historyStaleTime: 5 * 60 * 1000,
} as const;

const INSIGHTS_ROOT = ["insights"] as const;
const BRIEF_PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 50;

export const insightQueries = {
	all: () => INSIGHTS_ROOT,
	briefInfinite: (
		orgId: string | undefined,
		websiteId?: string | null,
		runId?: string | null
	) =>
		infiniteQueryOptions({
			queryKey: [
				...INSIGHTS_ROOT,
				"brief-infinite",
				orgId,
				websiteId ?? null,
				runId ?? null,
			] as const,
			queryFn: ({ pageParam }) =>
				fetchInsightsBriefPage(
					orgId ?? "",
					pageParam,
					BRIEF_PAGE_SIZE,
					websiteId ?? undefined,
					runId ?? undefined
				),
			initialPageParam: 0,
			getNextPageParam: (lastPage, _allPages, lastPageParam) =>
				lastPage.hasMore ? lastPageParam + BRIEF_PAGE_SIZE : undefined,
			enabled: !!orgId,
			staleTime: INSIGHT_CACHE.historyStaleTime,
			gcTime: INSIGHT_CACHE.gcTime,
			refetchOnWindowFocus: false,
			retry: 2,
			retryDelay: (attempt: number) => Math.min(2000 * 2 ** attempt, 15_000),
		}),
	inbox: (organizationId: string | undefined) =>
		queryOptions({
			queryKey: [...INSIGHTS_ROOT, "inbox", organizationId] as const,
			queryFn: () =>
				orpc.insights.inbox.call({ organizationId: organizationId ?? "" }),
			enabled: Boolean(organizationId),
			staleTime: 60 * 1000,
			gcTime: INSIGHT_CACHE.gcTime,
			refetchOnWindowFocus: true,
			refetchInterval: 60 * 1000,
			retry: 2,
			retryDelay: (attempt: number) => Math.min(2000 * 2 ** attempt, 15_000),
		}),
	byId: (insightId: string | undefined) =>
		queryOptions({
			queryKey: [...INSIGHTS_ROOT, "by-id", insightId] as const,
			queryFn: () => fetchInsightById(insightId ?? ""),
			enabled: !!insightId,
			staleTime: INSIGHT_CACHE.historyStaleTime,
			gcTime: INSIGHT_CACHE.gcTime,
			refetchOnWindowFocus: false,
			retry: 1,
		}),
	recommendationsInfinite: (organizationId: string | undefined) =>
		infiniteQueryOptions({
			queryKey: [...INSIGHTS_ROOT, "recommendations", organizationId] as const,
			queryFn: ({ pageParam }) =>
				orpc.insights.recommendations.call({
					organizationId: organizationId ?? "",
					limit: HISTORY_PAGE_SIZE,
					offset: pageParam,
				}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, _allPages, lastPageParam) =>
				lastPage.hasMore ? lastPageParam + HISTORY_PAGE_SIZE : undefined,
			enabled: Boolean(organizationId),
			staleTime: INSIGHT_CACHE.historyStaleTime,
			gcTime: INSIGHT_CACHE.gcTime,
		}),
};

function fetchInsightsBriefPage(
	organizationId: string,
	offset: number,
	limit = 50,
	websiteId?: string,
	runId?: string
) {
	return orpc.insights.brief.call({
		organizationId,
		limit,
		offset,
		...(runId ? { runId } : {}),
		...(websiteId ? { websiteId } : {}),
	});
}

type InsightsBriefPage = Awaited<ReturnType<typeof fetchInsightsBriefPage>>;
export type BriefInsight = InsightsBriefPage["insights"][number];

export const BRIEF_NEXT_LABELS: Record<
	NonNullable<BriefInsight["next"]>["type"],
	string
> = {
	act: "Next step",
	ask: "Needs your input",
	watch: "Measuring",
};

function fetchInsightById(insightId: string) {
	return orpc.insights.getById.call({ insightId });
}

export type InsightByIdResponse = Awaited<ReturnType<typeof fetchInsightById>>;

export type InboxThread = Awaited<
	ReturnType<typeof orpc.insights.inbox.call>
>["threads"][number];
