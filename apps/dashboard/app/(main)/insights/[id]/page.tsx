"use client";

import { isSelfHosted } from "@databuddy/env/public";

import { INVESTIGATION_USAGE } from "@databuddy/shared/billing";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/user-facing-error";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { MessageResponse } from "@/components/ai-elements/message";
import {
	type InboxThread,
	insightQueries,
	type InsightByIdResponse,
} from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import {
	ArrowLeftIcon,
	ArrowSquareOutIcon,
	CaretDownIcon,
	CopyIcon,
	GlobeIcon,
	LightbulbIcon,
	LinkBreakIcon,
	LinkIcon,
	RobotIcon,
	ShareNetworkIcon,
	UserIcon,
} from "@databuddy/ui/icons";
import { DropdownMenu } from "@databuddy/ui/client";
import {
	Button,
	buttonVariants,
	EmptyState,
	Field,
	formatDateTime,
	fromNow,
	Skeleton,
	Spinner,
	StatusDot,
	Textarea,
} from "@databuddy/ui";
import {
	MarkDoneButton,
	NEED_CONFIG,
	sectionHref,
	threadStatus,
	useInbox,
} from "../_components/inbox-state";
import {
	ExecuteDefinitionAction,
	FindingBody,
	formatPeriod,
	investigationSourceLink,
	nextCopy,
} from "../_components/investigation-row";

type TimelineItem = InsightByIdResponse["timeline"][number];
type InvestigationItem = Extract<TimelineItem, { kind: "investigation" }>;
type ReplyItem = Extract<TimelineItem, { kind: "reply" }>;

export default function InsightDetailPage() {
	const params = useParams();
	const router = useRouter();
	const insightId = typeof params.id === "string" ? params.id : "";
	const composerRef = useRef<HTMLTextAreaElement>(null);

	const { data, isLoading, isError } = useQuery({
		...insightQueries.byId(insightId || undefined),
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchInterval: (query) =>
			query.state.data?.timeline.some(
				(item) =>
					item.kind === "reply" &&
					(item.status === "queued" || item.status === "running")
			)
				? 2000
				: query.state.data?.insight?.status === "open"
					? 30_000
					: false,
	});
	const inbox = useInbox();
	const thread =
		inbox.data?.threads.find((candidate) => candidate.id === insightId) ?? null;

	const insight = data?.insight ?? null;
	const items = data?.timeline ?? [];
	const latestIndex = items.findLastIndex(
		(item) => item.kind === "investigation"
	);
	const latest =
		latestIndex >= 0 ? (items[latestIndex] as InvestigationItem) : null;
	const earlier = latestIndex > 0 ? items.slice(0, latestIndex) : [];
	const since = latestIndex >= 0 ? items.slice(latestIndex + 1) : items;
	const replies = since.filter(
		(item): item is ReplyItem => item.kind === "reply"
	);
	const recovered = insight?.resolvedReason === "recovered";
	const resolved = insight?.status === "resolved";
	const backHref = sectionHref(thread?.state ?? "needs_you");
	const sourceLink =
		latest && insight
			? investigationSourceLink(latest, insight.websiteId)
			: null;
	const focusComposer = () => {
		composerRef.current?.focus();
		composerRef.current?.scrollIntoView({ block: "center" });
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-4 pb-20 sm:px-6">
			<Link
				className="mt-3 inline-flex w-fit items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground lg:hidden"
				href={backHref}
			>
				<ArrowLeftIcon className="size-3.5 shrink-0" />
				Inbox
			</Link>

			{isLoading && (
				<div aria-busy className="space-y-3 py-6" role="status">
					<Skeleton className="h-5 w-2/3 rounded" />
					<Skeleton className="h-4 w-full rounded" />
					<Skeleton className="h-4 w-4/5 rounded" />
				</div>
			)}

			{!isLoading && insight && (
				<article aria-label="Investigation">
					<header className="space-y-2 border-b py-4">
						<div className="flex items-center justify-between gap-3">
							<p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
								<span className="truncate font-medium">
									{insight.websiteName ?? insight.websiteDomain}
								</span>
								{latest ? (
									<>
										<span className="text-muted-foreground/30">&middot;</span>
										<span className="shrink-0">
											{formatPeriod(latest.period.current)} vs{" "}
											{formatPeriod(latest.period.previous)}
										</span>
									</>
								) : null}
								<span className="text-muted-foreground/30">&middot;</span>
								<span className="flex shrink-0 items-center gap-1.5">
									<StatusDot
										color={
											resolved
												? "success"
												: thread?.state === "needs_you"
													? "warning"
													: "info"
										}
									/>
									{resolved
										? recovered
											? "Recovered"
											: "Done"
										: thread
											? threadStatus(thread)
											: "Open"}
								</span>
								{sourceLink ? (
									<>
										<span className="text-muted-foreground/30">&middot;</span>
										<Link
											className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
											href={sourceLink.href}
										>
											{sourceLink.label}
											<ArrowSquareOutIcon aria-hidden className="size-3" />
										</Link>
									</>
								) : null}
							</p>
							<ShareMenu
								insightId={insight.id}
								latestFindingAt={latest?.createdAt ?? null}
							/>
						</div>
						<h1 className="text-balance font-semibold text-foreground text-lg leading-snug">
							{latest?.outcome.title ?? insight.title}
						</h1>
					</header>

					<NextPanel
						insightId={insight.id}
						latest={latest}
						onAnswer={focusComposer}
						thread={thread}
					/>

					{latest ? (
						<section aria-label="Finding" className="py-4">
							<FindingBody evidenceOpen={!resolved} outcome={latest.outcome} />
						</section>
					) : null}

					{earlier.length > 0 ? <History items={earlier} /> : null}

					{replies.length > 0 ? (
						<section
							aria-label="Conversation"
							className="space-y-3 border-t py-4"
						>
							{replies.map((item) => (
								<ReplyEntry item={item} key={item.id} />
							))}
						</section>
					) : null}

					{data?.canReply ? (
						<Composer
							answerRequested={
								!resolved &&
								latest?.outcome.next.type === "ask" &&
								!replies.some((item) => item.intent === "analysis")
							}
							busy={replies.some(
								(item) => item.status === "queued" || item.status === "running"
							)}
							failedReply={
								replies.findLast((item) => item.status === "failed") ?? null
							}
							insightId={insight.id}
							textareaRef={composerRef}
						/>
					) : null}
				</article>
			)}

			{!(isLoading || insight) && (
				<EmptyState
					action={{
						label: "Back to the inbox",
						onClick: () => router.push("/insights"),
					}}
					className="min-h-[50dvh]"
					description={
						isError
							? "This investigation is unavailable, or it belongs to a workspace you can't access."
							: "This investigation no longer exists."
					}
					icon={<LightbulbIcon />}
					title="Investigation not available"
					variant="minimal"
				/>
			)}
		</div>
	);
}

function NextPanel({
	insightId,
	latest,
	onAnswer,
	thread,
}: {
	insightId: string;
	latest: InvestigationItem | null;
	onAnswer: () => void;
	thread: InboxThread | null;
}) {
	if (!latest) {
		return null;
	}
	const next = latest.outcome.next;
	const need = thread?.need ?? null;
	const execution = next.type === "act" ? next.execution : null;
	const definitionType =
		latest.entity.type === "goal" || latest.entity.type === "funnel"
			? latest.entity.type
			: null;
	const executable =
		execution &&
		definitionType &&
		(execution.operation === "edit" || execution.operation === "delete")
			? { definitionType, execution }
			: null;
	const copy = nextCopy(next, {
		verificationFailed: latest.outcome.verification?.status === "failed",
	});
	const pending = thread?.pendingReply ?? null;
	if (thread && pending && pending.status !== "failed") {
		return (
			<section
				aria-label="Next step"
				className="my-4 flex items-start gap-3 rounded border bg-muted/30 px-4 py-3"
			>
				<Spinner className="mt-0.5" size="sm" />
				<div>
					<p className="font-medium text-foreground text-sm">
						{threadStatus(thread)}
					</p>
					<p className="mt-0.5 text-pretty text-muted-foreground text-xs leading-relaxed">
						Databuddy is on it. The result lands here and in your inbox, usually
						within a few minutes.
					</p>
				</div>
			</section>
		);
	}

	return (
		<section
			aria-label="Next step"
			className={cn(
				"my-4 rounded border px-4 py-3",
				need ? "border-primary/20 bg-primary/5" : "bg-muted/30"
			)}
		>
			<p className="font-medium text-muted-foreground text-xs">
				{need ? NEED_CONFIG[need].heading : copy.label}
			</p>
			<p className="mt-1 text-pretty font-medium text-foreground text-sm leading-relaxed">
				{copy.body}
			</p>
			{copy.detail ? (
				<p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
					{copy.detail}
				</p>
			) : null}
			{need ? (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{need === "answer" ? (
						<Button onClick={onAnswer} size="sm" type="button">
							Answer
						</Button>
					) : null}
					{need === "apply" && executable ? (
						<ExecuteDefinitionAction
							action="Apply this fix"
							definitionType={executable.definitionType}
							entityLabel={latest.entity.label}
							execution={executable.execution}
							insightId={insightId}
						/>
					) : null}
					{need === "done" || (need === "apply" && !executable) ? (
						<MarkDoneButton insightId={insightId} label="I made this change" />
					) : null}
					{need === "look" ? (
						<Button
							onClick={onAnswer}
							size="sm"
							type="button"
							variant="secondary"
						>
							Tell Databuddy what changed
						</Button>
					) : null}
				</div>
			) : null}
		</section>
	);
}

function History({ items }: { items: TimelineItem[] }) {
	const [open, setOpen] = useState(false);
	return (
		<section aria-label="Earlier activity" className="border-t py-3">
			<Button
				aria-expanded={open}
				className="text-muted-foreground"
				onClick={() => setOpen((value) => !value)}
				size="sm"
				type="button"
				variant="ghost"
			>
				Earlier
				<span className="tabular-nums">({items.length})</span>
				<CaretDownIcon
					aria-hidden
					className={cn("size-3", open && "rotate-180")}
				/>
			</Button>
			{open ? (
				<ol className="mt-2 divide-y rounded border">
					{items.map((item) => (
						<HistoryRow item={item} key={`${item.kind}-${item.id}`} />
					))}
				</ol>
			) : null}
		</section>
	);
}

function HistoryRow({ item }: { item: TimelineItem }) {
	const [open, setOpen] = useState(false);
	const label =
		item.kind === "reply"
			? item.body
			: `${nextCopy(item.outcome.next).label}: ${item.outcome.title}`;
	return (
		<li>
			<Button
				aria-expanded={open}
				className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-left font-normal text-xs"
				onClick={() => setOpen((value) => !value)}
				type="button"
				variant="ghost"
			>
				<Avatar kind={item.kind} />
				<span className="min-w-0 flex-1 truncate text-foreground/85">
					{item.kind === "reply" ? `${item.author}: ${label}` : label}
				</span>
				<time
					className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
					dateTime={item.createdAt}
					title={formatDateTime(item.createdAt)}
				>
					{fromNow(item.createdAt)}
				</time>
			</Button>
			{open ? (
				<div className="border-t bg-muted/20 px-3 py-3">
					{item.kind === "reply" ? (
						<ReplyBody item={item} />
					) : (
						<div className="space-y-3">
							<p className="text-muted-foreground text-xs">
								{formatPeriod(item.period.current)} vs{" "}
								{formatPeriod(item.period.previous)}
							</p>
							<FindingBody evidenceOpen={false} outcome={item.outcome} />
							<p className="text-pretty text-muted-foreground text-xs leading-relaxed">
								<span className="font-medium">
									{nextCopy(item.outcome.next).label}:
								</span>{" "}
								{nextCopy(item.outcome.next).body}
							</p>
						</div>
					)}
				</div>
			) : null}
		</li>
	);
}

function Avatar({ kind }: { kind: TimelineItem["kind"] }) {
	return kind === "reply" ? (
		<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
			<UserIcon className="size-3" />
		</span>
	) : (
		<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
			<RobotIcon className="size-3" />
		</span>
	);
}

function ReplyEntry({ item }: { item: ReplyItem }) {
	return (
		<article className="space-y-2">
			<header className="flex items-center gap-2 text-xs">
				<Avatar kind="reply" />
				<span className="truncate font-medium text-foreground">
					{item.author}
				</span>
				<time
					className="shrink-0 text-[11px] text-muted-foreground"
					dateTime={item.createdAt}
					suppressHydrationWarning
					title={formatDateTime(item.createdAt)}
				>
					{fromNow(item.createdAt)}
				</time>
			</header>
			<ReplyBody item={item} />
		</article>
	);
}

function ReplyBody({ item }: { item: ReplyItem }) {
	return (
		<div className="space-y-2">
			<p className="whitespace-pre-wrap text-foreground/85 text-sm leading-relaxed">
				{item.body}
			</p>
			{item.assistantText ? (
				<div className="flex gap-2">
					<Avatar kind="investigation" />
					<MessageResponse
						className="min-w-0 text-sm leading-relaxed"
						mode="static"
					>
						{item.assistantText}
					</MessageResponse>
				</div>
			) : null}
			{item.status === "queued" || item.status === "running" ? (
				<div className="flex items-center gap-2 text-muted-foreground text-xs">
					<Spinner size="sm" />
					{item.status === "queued"
						? "Queued…"
						: item.intent === "clarification"
							? "Databuddy is answering…"
							: "Databuddy is investigating…"}
				</div>
			) : null}
		</div>
	);
}

function Composer({
	answerRequested,
	busy,
	failedReply,
	insightId,
	textareaRef,
}: {
	answerRequested: boolean;
	busy: boolean;
	failedReply: ReplyItem | null;
	insightId: string;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const queryClient = useQueryClient();
	const [body, setBody] = useState("");
	const refresh = () =>
		queryClient
			.invalidateQueries({ queryKey: insightQueries.all() })
			.catch(() => undefined);
	const reply = useMutation({
		...orpc.insights.reply.mutationOptions(),
		meta: { suppressGlobalErrorToast: true },
		onError: (error) => showErrorToast(error, "Could not send your message"),
		onSuccess: (result) => {
			setBody("");
			refresh();
			if (result.reply.status === "failed") {
				toast.error("Databuddy could not start on this", {
					description: "Your message was saved. Try again in a moment.",
				});
			}
		},
	});
	const retry = useMutation({
		...orpc.insights.retryReply.mutationOptions(),
		meta: { suppressGlobalErrorToast: true },
		onError: (error) => showErrorToast(error, "Could not retry"),
		onSuccess: (result) => {
			refresh();
			if (result.status === "failed") {
				toast.error("Databuddy could not start on this", {
					description: "Try again in a moment.",
				});
			}
		},
	});
	const pending = reply.isPending || retry.isPending;
	const send = (intent: "analysis" | "clarification") => {
		const trimmed = body.trim();
		if (!trimmed || busy || pending) {
			return;
		}
		reply.mutate({
			body: trimmed,
			insightId,
			intent,
			...(intent === "analysis"
				? { acceptedPriceUsd: INVESTIGATION_USAGE.priceUsd }
				: {}),
		});
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		send(answerRequested ? "analysis" : "clarification");
	};
	const costNote = isSelfHosted
		? null
		: answerRequested
			? "Continuing uses 1 investigation from your allowance, then costs $1."
			: "Questions are free. A new investigation uses your allowance, then costs $1.";

	return (
		<form className="border-t pt-4" onSubmit={submit}>
			{failedReply && !busy ? (
				<div className="mb-3 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					Your last message did not go through.
					<Button
						loading={retry.isPending}
						onClick={() => retry.mutate({ replyId: failedReply.id })}
						size="sm"
						type="button"
						variant="secondary"
					>
						Try again
					</Button>
				</div>
			) : null}
			<Field>
				<Field.Label className={answerRequested ? undefined : "sr-only"}>
					{answerRequested ? "Your answer" : "Message"}
				</Field.Label>
				<Textarea
					disabled={busy}
					maxLength={2000}
					maxRows={8}
					minRows={2}
					onChange={(event) => setBody(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							send(answerRequested ? "analysis" : "clarification");
						}
					}}
					placeholder={
						busy
							? "Databuddy is working on this…"
							: answerRequested
								? "Answer the question above…"
								: "Ask Databuddy about this finding…"
					}
					ref={textareaRef}
					value={body}
				/>
				<div className="flex flex-wrap items-center justify-between gap-2">
					{costNote ? (
						<p className="text-pretty text-muted-foreground text-xs">
							{costNote}
						</p>
					) : (
						<span />
					)}
					<div className="flex items-center gap-2">
						{answerRequested ? null : (
							<Button
								disabled={busy || !body.trim() || pending}
								onClick={() => send("analysis")}
								size="sm"
								type="button"
								variant="ghost"
							>
								Run a new investigation
							</Button>
						)}
						<Button
							disabled={busy || !body.trim() || pending}
							loading={reply.isPending}
							size="sm"
							type="submit"
						>
							{answerRequested ? "Answer" : "Send"}
						</Button>
					</div>
				</div>
			</Field>
		</form>
	);
}

function ShareMenu({
	insightId,
	latestFindingAt,
}: {
	insightId: string;
	latestFindingAt: string | null;
}) {
	const queryClient = useQueryClient();
	const { copyToClipboard } = useCopyToClipboard();
	const shareInput = { input: { insightId } };
	const { data, isPending } = useQuery(
		orpc.insights.getShare.queryOptions(shareInput)
	);
	const share = data?.share ?? null;
	const canPublish = data?.canPublish ?? false;
	const publicUrl = (shareId: string) =>
		`${window.location.origin}/public/investigations/${shareId}`;
	const refreshShare = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.insights.getShare.key(shareInput),
		});

	const publish = useMutation({
		...orpc.insights.publishShare.mutationOptions(),
		onError: (error) => {
			showErrorToast(error, "Failed to publish public link");
		},
		meta: { suppressGlobalErrorToast: true },
		onSuccess: (published) => {
			refreshShare();
			copyToClipboard(publicUrl(published.id));
			toast.success(
				published.version === 1
					? "Public link copied"
					: `Version ${published.version} published`,
				{
					description:
						"Anyone with the link sees this version until you publish again.",
				}
			);
		},
	});
	const unpublish = useMutation({
		...orpc.insights.unpublishShare.mutationOptions(),
		onError: (error) => {
			showErrorToast(error, "Failed to turn off public link");
		},
		meta: { suppressGlobalErrorToast: true },
		onSuccess: () => {
			refreshShare();
			toast.success("Public link turned off");
		},
	});
	const busy = publish.isPending || unpublish.isPending;
	const hasUnpublishedFindings = Boolean(
		share && latestFindingAt && latestFindingAt > share.publishedAt
	);

	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				className={buttonVariants({ size: "sm", variant: "secondary" })}
			>
				<ShareNetworkIcon className="size-4" />
				Share
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" className="w-64">
				<DropdownMenu.Item
					onClick={() => {
						copyToClipboard(window.location.href);
						toast.success("Link copied", {
							description: "Members of your organization can open it.",
						});
					}}
				>
					<LinkIcon className="size-3.5" />
					Copy link for your team
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Group>
					<DropdownMenu.GroupLabel>
						{share
							? `Public · V${share.version} published ${formatDateTime(share.publishedAt)}`
							: "Public link off"}
					</DropdownMenu.GroupLabel>
					{share ? (
						<>
							<DropdownMenu.Item
								onClick={() => {
									copyToClipboard(publicUrl(share.id));
									toast.success("Public link copied");
								}}
							>
								<CopyIcon className="size-3.5" />
								Copy public link
							</DropdownMenu.Item>
							<DropdownMenu.Item
								onClick={() =>
									window.open(publicUrl(share.id), "_blank", "noopener")
								}
							>
								<ArrowSquareOutIcon className="size-3.5" />
								View as a visitor
							</DropdownMenu.Item>
							{canPublish ? (
								<>
									<DropdownMenu.Item
										disabled={busy}
										onClick={() => publish.mutate({ insightId })}
									>
										<GlobeIcon className="size-3.5" />
										{hasUnpublishedFindings
											? "Publish new findings"
											: "Publish new version"}
									</DropdownMenu.Item>
									<DropdownMenu.Item
										disabled={busy}
										onClick={() => unpublish.mutate({ insightId })}
										variant="destructive"
									>
										<LinkBreakIcon className="size-3.5" />
										Turn off public link
									</DropdownMenu.Item>
								</>
							) : null}
						</>
					) : (
						<DropdownMenu.Item
							disabled={isPending || busy || !canPublish}
							onClick={() => publish.mutate({ insightId })}
						>
							<GlobeIcon className="size-3.5" />
							{canPublish || isPending
								? "Publish a public link"
								: "Editors can publish a public link"}
						</DropdownMenu.Item>
					)}
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
