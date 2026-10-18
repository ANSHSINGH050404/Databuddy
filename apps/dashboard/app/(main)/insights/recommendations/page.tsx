"use client";

import type { InsightRecommendationItem } from "@databuddy/shared/insights";
import { Button, Card, dayjs, EmptyState, Skeleton } from "@databuddy/ui";
import { LightbulbIcon } from "@databuddy/ui/icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { insightQueries } from "@/lib/insight-api";
import { investigationSourceLink } from "../_components/investigation-row";

export default function RecommendationsPage() {
	const { activeOrganization, activeOrganizationId, isLoading } =
		useOrganizationsContext();
	const query = useInfiniteQuery(
		insightQueries.recommendationsInfinite(
			activeOrganization?.id ?? activeOrganizationId ?? undefined
		)
	);
	const items = query.data?.pages.flatMap((page) => page.recommendations) ?? [];

	return (
		<div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
			<Card aria-label="Recommendations">
				<Card.Header className="border-b">
					<Card.Title>Recommendations</Card.Title>
					<Card.Description className="mt-1">
						Review suggestions grounded in your analytics and see what you
						saved.
					</Card.Description>
				</Card.Header>
				<Card.Content className="p-0">
					{isLoading || query.isLoading ? (
						<div
							aria-label="Loading recommendations"
							className="space-y-3 p-5"
							role="status"
						>
							<Skeleton className="h-4 w-2/3" />
							<Skeleton className="h-4 w-full" />
						</div>
					) : query.isError ? (
						<EmptyState
							action={{ label: "Try again", onClick: () => query.refetch() }}
							description="Databuddy couldn't load recommendations."
							icon={<LightbulbIcon />}
							title="Failed to load recommendations"
							variant="error"
						/>
					) : items.length === 0 ? (
						<EmptyState
							description="Useful suggestions will appear here after Databuddy reviews your analytics."
							icon={<LightbulbIcon />}
							title="No recommendations yet"
							variant="minimal"
						/>
					) : (
						<div className="divide-y">
							{items.map((item) => (
								<Recommendation item={item} key={item.id} />
							))}
						</div>
					)}
					{query.hasNextPage ? (
						<div className="flex justify-center border-t p-4">
							<Button
								loading={query.isFetchingNextPage}
								onClick={() => query.fetchNextPage()}
								variant="secondary"
							>
								Load more
							</Button>
						</div>
					) : null}
				</Card.Content>
			</Card>
		</div>
	);
}

function Recommendation({ item }: { item: InsightRecommendationItem }) {
	const review = item.recommendation.review;
	const definitionType = review?.type.endsWith("goal") ? "goal" : "funnel";
	const saved = item.saved;
	const dateParams = {
		startDate: item.signal.period.current.from,
		endDate: item.signal.period.current.to,
	};
	const reviewHref =
		review && !saved
			? `/websites/${encodeURIComponent(item.websiteId)}/${definitionType}s?${new URLSearchParams({ recommendationId: item.id, ...dateParams })}`
			: null;
	const savedHref =
		saved && !saved.deleted
			? `/websites/${encodeURIComponent(item.websiteId)}/${saved.definitionType}s?${new URLSearchParams({ ...dateParams, [`${saved.definitionType}Id`]: saved.definitionId })}`
			: null;
	const source = investigationSourceLink(item.signal, item.websiteId);
	return (
		<article className="space-y-3 p-4 sm:p-5">
			<p className="text-muted-foreground text-xs">
				{item.websiteName ?? item.websiteDomain} ·{" "}
				{dayjs.utc(item.signal.period.current.from).format("MMM D")}–
				{dayjs.utc(item.signal.period.current.to).format("MMM D, YYYY")}
			</p>
			<h2 className="font-medium text-sm">{item.recommendation.summary}</h2>
			<p className="text-muted-foreground text-xs">
				{saved ? (
					<>
						{saved.deleted
							? "Saved definition removed"
							: saved.current
								? saved.adjusted
									? "Saved with your edits"
									: "Saved from this recommendation"
								: "Saved, then changed"}
						{saved.name ? ` · ${saved.name}` : ""} ·{" "}
						{dayjs.utc(saved.savedAt).format("MMM D, YYYY")}
					</>
				) : (
					<>
						Review by{" "}
						{dayjs.utc(item.expiresAt).format("MMM D, YYYY [at] HH:mm [UTC]")}
					</>
				)}
			</p>
			<p className="text-muted-foreground text-sm">
				{item.title}: {item.summary}
			</p>
			<ul className="list-inside list-disc space-y-1 text-muted-foreground text-xs">
				{item.evidence.map((entry) => (
					<li key={entry}>{entry}</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-2">
				{savedHref ? (
					<Button asChild size="sm" variant="secondary">
						<Link href={savedHref}>View saved {saved?.definitionType}</Link>
					</Button>
				) : null}
				{reviewHref ? (
					<Button asChild size="sm" variant="secondary">
						<Link href={reviewHref}>
							Review {definitionType}{" "}
							{review?.type.startsWith("create_") ? "draft" : "changes"}
						</Link>
					</Button>
				) : null}
				{item.investigationId || source ? (
					<Button asChild size="sm" variant="ghost">
						<Link
							href={
								item.investigationId
									? `/insights/${item.investigationId}`
									: (source?.href ?? "/insights")
							}
						>
							View source
						</Link>
					</Button>
				) : null}
			</div>
		</article>
	);
}
