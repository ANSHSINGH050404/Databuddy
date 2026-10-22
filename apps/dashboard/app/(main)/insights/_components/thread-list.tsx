"use client";

import type { InsightRecommendationItem } from "@databuddy/shared/insights";
import { Button, dayjs, EmptyState, fromNow, Skeleton } from "@databuddy/ui";
import {
	BellIcon,
	CheckCircleIcon,
	ClockIcon,
	LightbulbIcon,
} from "@databuddy/ui/icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { type InboxThread, insightQueries } from "@/lib/insight-api";
import { cn } from "@/lib/utils";
import {
	type InboxSection,
	NEED_CONFIG,
	NEED_ORDER,
	sectionHref,
	threadGlyph,
	threadStatus,
	useInbox,
} from "./inbox-state";

export function ThreadList({
	section,
	selectedId,
}: {
	section: InboxSection;
	selectedId: string | null;
}) {
	const inbox = useInbox();
	const suggestions = useSuggestions();
	const threads = inbox.data?.threads ?? [];
	const items =
		suggestions.data?.pages.flatMap((page) => page.recommendations) ?? [];
	const pendingSuggestions = items.filter((item) => !item.saved);
	const savedSuggestions = items.filter((item) => item.saved);
	const count = (state: InboxThread["state"]) =>
		threads.filter((thread) => thread.state === state).length +
		(state === "needs_you"
			? pendingSuggestions.length
			: state === "resolved"
				? savedSuggestions.length
				: 0);
	const visible = threads.filter((thread) => thread.state === section);
	const visibleSuggestions =
		section === "needs_you"
			? pendingSuggestions
			: section === "resolved"
				? savedSuggestions
				: [];
	const loading = inbox.isLoading || suggestions.isLoading;
	const empty = visible.length === 0 && visibleSuggestions.length === 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionTabs
				counts={{ needs_you: count("needs_you"), watching: count("watching") }}
				section={section}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<ThreadListSkeleton />
				) : inbox.isError ? (
					<EmptyState
						action={{
							label: "Try again",
							onClick: () => {
								inbox.refetch().catch(() => undefined);
							},
							variant: "secondary",
						}}
						className="px-5 py-12"
						description="Databuddy couldn't load your investigations."
						icon={<LightbulbIcon />}
						title="Failed to load"
						variant="error"
					/>
				) : empty ? (
					<EmptyThreadList section={section} watching={count("watching")} />
				) : section === "needs_you" ? (
					<NeedsYouGroups
						selectedId={selectedId}
						suggestions={visibleSuggestions}
						threads={visible}
					/>
				) : (
					<ul className="divide-y">
						{[
							...visible.map((thread) => ({
								at: thread.lastActivityAt,
								node: (
									<ThreadRow
										key={thread.id}
										selected={thread.id === selectedId}
										thread={thread}
									/>
								),
							})),
							...visibleSuggestions.map((item) => ({
								at: item.saved?.savedAt ?? item.createdAt,
								node: (
									<SuggestionRow
										item={item}
										key={item.id}
										selected={item.id === selectedId}
									/>
								),
							})),
						]
							.sort((a, b) => (a.at < b.at ? 1 : -1))
							.map((entry) => entry.node)}
					</ul>
				)}
				{suggestions.hasNextPage && section !== "watching" ? (
					<div className="flex justify-center border-t p-3">
						<Button
							loading={suggestions.isFetchingNextPage}
							onClick={() => suggestions.fetchNextPage()}
							size="sm"
							variant="ghost"
						>
							Load more suggestions
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}

const SECTIONS: { id: InboxSection; label: string }[] = [
	{ id: "needs_you", label: "Needs you" },
	{ id: "watching", label: "Watching" },
	{ id: "resolved", label: "Done" },
];

function SectionTabs({
	counts,
	section,
}: {
	counts: Partial<Record<InboxSection, number>>;
	section: InboxSection;
}) {
	return (
		<nav
			aria-label="Inbox sections"
			className="flex h-10 shrink-0 border-b bg-accent/30"
		>
			{SECTIONS.map((tab) => {
				const active = tab.id === section;
				const count = counts[tab.id] ?? 0;
				return (
					<Link
						aria-current={active ? "page" : undefined}
						className={cn(
							"relative flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-1 font-medium text-xs transition-colors",
							active
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						href={sectionHref(tab.id)}
						key={tab.id}
					>
						<span className="truncate">{tab.label}</span>
						{count > 0 ? (
							<span
								className={cn(
									"flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-semibold text-[10px] tabular-nums leading-4",
									tab.id === "needs_you"
										? "bg-destructive text-destructive-foreground"
										: active
											? "bg-primary text-primary-foreground"
											: "bg-muted text-foreground"
								)}
							>
								{count > 99 ? "99+" : count}
								<span className="sr-only">
									{tab.id === "needs_you" ? " waiting for you" : " open"}
								</span>
							</span>
						) : null}
						{active ? (
							<span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand-purple" />
						) : null}
					</Link>
				);
			})}
		</nav>
	);
}

function NeedsYouGroups({
	selectedId,
	suggestions,
	threads,
}: {
	selectedId: string | null;
	suggestions: InsightRecommendationItem[];
	threads: InboxThread[];
}) {
	return (
		<div>
			{suggestions.length > 0 ? (
				<section aria-label="Review a suggestion">
					<GroupHeading
						count={suggestions.length}
						label="Review a suggestion"
					/>
					<ul className="divide-y">
						{suggestions.map((item) => (
							<SuggestionRow
								item={item}
								key={item.id}
								selected={item.id === selectedId}
							/>
						))}
					</ul>
				</section>
			) : null}
			{NEED_ORDER.flatMap((need) => {
				const items = threads.filter((thread) => thread.need === need);
				if (items.length === 0) {
					return [];
				}
				return [
					<section aria-label={NEED_CONFIG[need].heading} key={need}>
						<GroupHeading
							count={items.length}
							label={NEED_CONFIG[need].heading}
						/>
						<ul className="divide-y">
							{items.map((thread) => (
								<ThreadRow
									key={thread.id}
									selected={thread.id === selectedId}
									thread={thread}
								/>
							))}
						</ul>
					</section>,
				];
			})}
		</div>
	);
}

function GroupHeading({ count, label }: { count: number; label: string }) {
	return (
		<h3 className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-1.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider backdrop-blur">
			{label}
			<span className="font-medium tabular-nums">{count}</span>
		</h3>
	);
}

function ThreadRow({
	selected,
	thread,
}: {
	selected: boolean;
	thread: InboxThread;
}) {
	const glyph = threadGlyph(thread);
	return (
		<li>
			<Link
				aria-current={selected ? "page" : undefined}
				className={cn(
					"flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50",
					selected && "bg-accent hover:bg-accent"
				)}
				href={`/insights/${thread.id}`}
			>
				<span
					className={cn(
						"mt-0.5 flex size-7 shrink-0 items-center justify-center rounded",
						glyph.tone
					)}
				>
					<glyph.icon aria-hidden className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline justify-between gap-3">
						<span
							className={cn(
								"truncate text-sm",
								thread.need ? "font-semibold text-foreground" : "font-medium"
							)}
						>
							{thread.title}
						</span>
						<time
							className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
							dateTime={thread.lastActivityAt}
						>
							{fromNow(thread.lastActivityAt)}
						</time>
					</span>
					<span className="mt-0.5 line-clamp-1 block text-muted-foreground text-xs">
						{thread.summary}
					</span>
					<span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate">
							{thread.websiteName ?? thread.websiteDomain}
						</span>
						{thread.need ? null : (
							<>
								<span className="text-muted-foreground/30">&middot;</span>
								<span className="truncate">{threadStatus(thread)}</span>
							</>
						)}
					</span>
				</span>
			</Link>
		</li>
	);
}

function suggestionHref(id: string): string {
	return `/insights/recommendations?${new URLSearchParams({ id })}`;
}

export function useSuggestions() {
	const { activeOrganization, activeOrganizationId } =
		useOrganizationsContext();
	const organizationId =
		activeOrganization?.id ?? activeOrganizationId ?? undefined;
	return useInfiniteQuery(
		insightQueries.recommendationsInfinite(organizationId)
	);
}

function suggestionStatus(item: InsightRecommendationItem): string {
	if (item.saved) {
		return item.saved.deleted
			? "Saved, then removed"
			: item.saved.current
				? "Saved"
				: "Saved, then changed";
	}
	return `Review by ${dayjs.utc(item.expiresAt).format("MMM D")}`;
}

function SuggestionRow({
	item,
	selected,
}: {
	item: InsightRecommendationItem;
	selected: boolean;
}) {
	return (
		<li>
			<Link
				aria-current={selected ? "page" : undefined}
				className={cn(
					"flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50",
					selected && "bg-accent hover:bg-accent"
				)}
				href={suggestionHref(item.id)}
			>
				<span
					className={cn(
						"mt-0.5 flex size-7 shrink-0 items-center justify-center rounded",
						item.saved
							? "bg-success/10 text-success"
							: "bg-primary/10 text-primary"
					)}
				>
					{item.saved ? (
						<CheckCircleIcon aria-hidden className="size-3.5" />
					) : (
						<LightbulbIcon aria-hidden className="size-3.5" />
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline justify-between gap-3">
						<span
							className={cn(
								"truncate text-sm",
								item.saved ? "font-medium" : "font-semibold text-foreground"
							)}
						>
							{item.recommendation.summary}
						</span>
						<time
							className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
							dateTime={item.createdAt}
						>
							{fromNow(item.createdAt)}
						</time>
					</span>
					<span className="mt-0.5 line-clamp-1 block text-muted-foreground text-xs">
						{item.title}
					</span>
					<span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate">
							{item.websiteName ?? item.websiteDomain}
						</span>
						<span className="text-muted-foreground/30">&middot;</span>
						<span className="truncate">{suggestionStatus(item)}</span>
					</span>
				</span>
			</Link>
		</li>
	);
}

function EmptyThreadList({
	section,
	watching,
}: {
	section: InboxSection;
	watching: number;
}) {
	if (section === "needs_you") {
		return (
			<EmptyState
				action={
					watching > 0 ? (
						<Button asChild size="sm" variant="secondary">
							<Link href={sectionHref("watching")}>See what it's watching</Link>
						</Button>
					) : undefined
				}
				className="px-5 py-12"
				description={
					watching > 0
						? `Databuddy is watching ${watching} open ${watching === 1 ? "case" : "cases"} and will ask when something changes.`
						: "Databuddy will ask here when a finding or a suggestion needs a decision from you."
				}
				icon={<BellIcon />}
				title="Nothing needs you"
				variant="minimal"
			/>
		);
	}
	if (section === "watching") {
		return (
			<EmptyState
				className="px-5 py-12"
				description="Once you answer a question or apply a fix, Databuddy verifies it here."
				icon={<ClockIcon />}
				title="Nothing in progress"
				variant="minimal"
			/>
		);
	}
	return (
		<EmptyState
			className="px-5 py-12"
			description="Verified fixes, recovered findings, closed cases and saved suggestions collect here."
			icon={<CheckCircleIcon />}
			title="Nothing done yet"
			variant="minimal"
		/>
	);
}

function ThreadListSkeleton() {
	return (
		<div aria-busy className="divide-y" role="status">
			{Array.from({ length: 6 }, (_, index) => (
				<div className="flex gap-3 px-4 py-3" key={`thread-${index + 1}`}>
					<Skeleton className="size-7 shrink-0 rounded" />
					<div className="min-w-0 flex-1 space-y-1.5">
						<Skeleton className="h-3.5 w-3/5 rounded" />
						<Skeleton className="h-3 w-full rounded" />
						<Skeleton className="h-3 w-1/3 rounded" />
					</div>
				</div>
			))}
		</div>
	);
}
