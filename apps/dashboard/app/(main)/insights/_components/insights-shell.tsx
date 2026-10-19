"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@databuddy/ui";
import { GlobeIcon } from "@databuddy/ui/icons";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { useWebsitesLight } from "@/hooks/use-websites";
import { insightQueries } from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import { isActiveRun } from "../_lib/insight-run";
import { type InboxSection, useInbox } from "./inbox-state";
import { InvestigationSettings } from "./investigation-settings";
import { InvestigationsAccessNotice } from "./investigations-access-notice";
import { ThreadList, useSuggestions } from "./thread-list";

const SECTION_ROUTES: Record<string, InboxSection> = {
	"/insights": "needs_you",
	"/insights/first-review": "needs_you",
	"/insights/recommendations": "needs_you",
	"/insights/resolved": "resolved",
	"/insights/watching": "watching",
};

export function InsightsShell({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const { activeOrganization, activeOrganizationId } =
		useOrganizationsContext();
	const organizationId =
		activeOrganization?.id ?? activeOrganizationId ?? undefined;
	const queryClient = useQueryClient();
	const latestRun = useQuery({
		...orpc.insightGeneration.getLatestRun.queryOptions({
			input: { organizationId },
		}),
		enabled: Boolean(organizationId),
		meta: { suppressGlobalErrorToast: true },
		refetchInterval: (query) => {
			const failures = query.state.fetchFailureCount;
			if (failures > 0) {
				return Math.min(30_000 * 2 ** Math.min(failures - 1, 3), 5 * 60_000);
			}
			return isActiveRun(query.state.data?.status) ? 2000 : 30_000;
		},
	});
	const { websites, isLoading: websitesLoading } = useWebsitesLight();
	const hasNoWebsites =
		!websitesLoading && websites !== undefined && websites.length === 0;
	const inbox = useInbox();
	const suggestions = useSuggestions();
	const refreshInsights = useCallback(() => {
		queryClient
			.invalidateQueries({ queryKey: insightQueries.all() })
			.catch(() => undefined);
	}, [queryClient]);
	const latestRunTracker = useRef<{
		organizationId: string;
		terminalRunId: string | null;
	} | null>(null);

	useEffect(() => {
		if (!organizationId) {
			latestRunTracker.current = null;
			return;
		}
		if (!latestRun.isSuccess) {
			if (latestRunTracker.current?.organizationId !== organizationId) {
				latestRunTracker.current = null;
			}
			return;
		}

		const run = latestRun.data;
		const tracked = latestRunTracker.current;
		if (!tracked || tracked.organizationId !== organizationId) {
			latestRunTracker.current = {
				organizationId,
				terminalRunId: run && !isActiveRun(run.status) ? run.id : null,
			};
			if (run && !isActiveRun(run.status)) {
				refreshInsights();
			}
			return;
		}
		if (!run || isActiveRun(run.status) || tracked.terminalRunId === run.id) {
			return;
		}

		latestRunTracker.current = {
			organizationId,
			terminalRunId: run.id,
		};
		refreshInsights();
	}, [latestRun.data, latestRun.isSuccess, organizationId, refreshInsights]);

	const isAnalyzing = isActiveRun(latestRun.data?.status);

	const isSectionRoute = pathname in SECTION_ROUTES;
	const threadId =
		!isSectionRoute && pathname.startsWith("/insights/")
			? (pathname.split("/")[2] ?? null)
			: null;
	const suggestionId =
		pathname === "/insights/recommendations" ? searchParams.get("id") : null;
	const selectedSuggestion = suggestionId
		? (suggestions.data?.pages
				.flatMap((page) => page.recommendations)
				.find((item) => item.id === suggestionId) ?? null)
		: null;
	const isThreadRoute = Boolean(
		threadId || suggestionId || pathname === "/insights/first-review"
	);
	const selectedThread = threadId
		? (inbox.data?.threads.find((thread) => thread.id === threadId) ?? null)
		: null;
	const section: InboxSection = threadId
		? (selectedThread?.state ?? "needs_you")
		: selectedSuggestion?.saved
			? "resolved"
			: (SECTION_ROUTES[pathname] ?? "needs_you");

	return (
		<div className="flex h-full min-h-0 flex-col" aria-busy={websitesLoading}>
			<TopBar.Title>
				<h1 className="font-semibold text-sm">Insights</h1>
			</TopBar.Title>
			<TopBar.Actions>
				<InvestigationSettings
					isAnalyzing={isAnalyzing}
					key={organizationId}
					organizationId={organizationId}
				/>
			</TopBar.Actions>

			<InvestigationsAccessNotice organizationId={organizationId} />

			{hasNoWebsites ? (
				<EmptyState
					action={{
						label: "Go to websites",
						onClick: () => {
							window.location.href = "/websites";
						},
					}}
					description="Add a website to start receiving insights across your organization."
					icon={<GlobeIcon />}
					title="No websites yet"
					variant="minimal"
				/>
			) : (
				<div className="flex min-h-0 flex-1">
					<aside
						aria-label="Investigation threads"
						className={cn(
							"min-h-0 w-full shrink-0 flex-col border-r bg-background lg:flex lg:w-[24rem] xl:w-[26rem]",
							isThreadRoute ? "hidden" : "flex"
						)}
					>
						<ThreadList
							section={section}
							selectedId={threadId ?? suggestionId}
						/>
					</aside>
					<main
						className={cn(
							"min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none lg:block",
							isThreadRoute ? "block" : "hidden"
						)}
					>
						{children}
					</main>
				</div>
			)}
		</div>
	);
}
