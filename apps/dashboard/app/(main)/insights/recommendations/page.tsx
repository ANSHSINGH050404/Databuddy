"use client";

import type { InsightRecommendationItem } from "@databuddy/shared/insights";
import { Button, dayjs, EmptyState, Skeleton } from "@databuddy/ui";
import { ArrowLeftIcon, LightbulbIcon } from "@databuddy/ui/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { InboxEmptyPane } from "../_components/inbox";
import { investigationSourceLink } from "../_components/investigation-row";
import { useSuggestions } from "../_components/thread-list";

export default function RecommendationsPage() {
	return (
		<Suspense fallback={null}>
			<RecommendationPane />
		</Suspense>
	);
}

function RecommendationPane() {
	const id = useSearchParams().get("id");
	const query = useSuggestions();
	if (!id) {
		return <InboxEmptyPane section="needs_you" />;
	}
	const item = query.data?.pages
		.flatMap((page) => page.recommendations)
		.find((candidate) => candidate.id === id);

	return (
		<div className="mx-auto w-full max-w-3xl px-4 pb-20 sm:px-6">
			<Link
				className="mt-3 inline-flex w-fit items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground lg:hidden"
				href="/insights/recommendations"
			>
				<ArrowLeftIcon className="size-3.5 shrink-0" />
				Suggestions
			</Link>
			{query.isLoading ? (
				<div aria-busy className="space-y-3 py-6" role="status">
					<Skeleton className="h-5 w-2/3 rounded" />
					<Skeleton className="h-4 w-full rounded" />
					<Skeleton className="h-4 w-4/5 rounded" />
				</div>
			) : item ? (
				<Recommendation item={item} />
			) : (
				<EmptyState
					action={
						<Button asChild size="sm" variant="secondary">
							<Link href="/insights/recommendations">Back to suggestions</Link>
						</Button>
					}
					className="min-h-[50dvh]"
					description="This suggestion expired or belongs to another workspace."
					icon={<LightbulbIcon />}
					title="Suggestion not available"
					variant="minimal"
				/>
			)}
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
		<article aria-label="Suggestion">
			<header className="space-y-2 border-b py-4">
				<p className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
					<span className="truncate font-medium">
						{item.websiteName ?? item.websiteDomain}
					</span>
					<span className="text-muted-foreground/30">&middot;</span>
					<span className="shrink-0">
						{dayjs.utc(item.signal.period.current.from).format("MMM D")}–
						{dayjs.utc(item.signal.period.current.to).format("MMM D, YYYY")}
					</span>
				</p>
				<h1 className="text-balance font-semibold text-foreground text-lg leading-snug">
					{item.recommendation.summary}
				</h1>
				<p className="text-pretty text-muted-foreground text-sm">
					{item.title}: {item.summary}
				</p>
			</header>
			<section
				aria-label="Next step"
				className={
					saved
						? "my-4 rounded border bg-muted/30 px-4 py-3"
						: "my-4 rounded border border-primary/20 bg-primary/5 px-4 py-3"
				}
			>
				<p className="font-medium text-muted-foreground text-xs">
					{saved ? "Saved" : "Suggestion"}
				</p>
				<p className="mt-1 text-pretty font-medium text-foreground text-sm leading-relaxed">
					{saved
						? `${
								saved.deleted
									? "The saved definition was removed"
									: saved.current
										? saved.adjusted
											? "Saved with your edits"
											: "Saved from this suggestion"
										: "Saved, then changed"
							}${saved.name ? ` · ${saved.name}` : ""} · ${dayjs.utc(saved.savedAt).format("MMM D, YYYY")}`
						: `Review the ${definitionType} ${review?.type.startsWith("create_") ? "draft" : "changes"} before ${dayjs.utc(item.expiresAt).format("MMM D")}, or let the suggestion expire.`}
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{savedHref ? (
						<Button asChild size="sm" variant="secondary">
							<Link href={savedHref}>View saved {saved?.definitionType}</Link>
						</Button>
					) : null}
					{reviewHref ? (
						<Button asChild size="sm">
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
			</section>
			{item.evidence.length > 0 ? (
				<section aria-label="Evidence" className="py-2">
					<h2 className="font-medium text-muted-foreground text-xs">
						Evidence
					</h2>
					<ul className="mt-2 list-inside list-disc space-y-1 text-muted-foreground text-sm">
						{item.evidence.map((entry) => (
							<li key={entry}>{entry}</li>
						))}
					</ul>
				</section>
			) : null}
		</article>
	);
}
