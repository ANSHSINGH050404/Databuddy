"use client";

import { authClient } from "@databuddy/auth/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	InsightTimelineInvestigation,
	InvestigationOutcome,
} from "@databuddy/shared/insights";
import { Button, dayjs } from "@databuddy/ui";
import { DeleteDialog } from "@databuddy/ui/client";
import { useId, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/user-facing-error";
import { insightQueries } from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import { CaretDownIcon } from "@databuddy/ui/icons";
import { ContextUsed } from "./context-used";

type InvestigationItem = InsightTimelineInvestigation;
type InvestigationNext = InvestigationOutcome["next"];

type DefinitionExecution = Extract<
	NonNullable<
		Extract<InvestigationOutcome["next"], { type: "act" }>["execution"]
	>,
	{ operation: "delete" | "edit" }
>;

export function ExecuteDefinitionAction({
	action,
	entityLabel,
	execution,
	insightId,
	definitionType,
}: {
	action: string;
	entityLabel: string;
	execution: DefinitionExecution;
	definitionType: "funnel" | "goal";
	insightId: string;
}) {
	const queryClient = useQueryClient();
	const memberRole = authClient.useActiveMemberRole();
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const apply = useMutation({
		...orpc.insights.applyAction.mutationOptions(),
		onError: (error) => {
			showErrorToast(error, `Failed to apply ${definitionType} change`);
		},
		meta: { suppressGlobalErrorToast: true },
		onSuccess: ({ reply }) => {
			queryClient.invalidateQueries({ queryKey: insightQueries.all() });
			queryClient.invalidateQueries({
				queryKey:
					definitionType === "funnel" ? orpc.funnels.key() : orpc.goals.key(),
			});
			const noun = definitionType === "funnel" ? "Funnel" : "Goal";
			toast.success(
				reply.status === "failed"
					? `${noun} change applied, but verification could not start`
					: `${noun} change applied. Verifying the result`
			);
		},
	});
	const deleting = execution.operation === "delete";
	const accessReason = memberRole.isPending
		? "Checking access…"
		: memberRole.data?.role === "viewer"
			? `You have view-only access to this ${definitionType}.`
			: memberRole.data
				? null
				: `You need edit access to change this ${definitionType}.`;

	return (
		<div className="space-y-1.5">
			<Button
				disabled={Boolean(accessReason) || apply.isPending}
				loading={apply.isPending}
				onClick={() => {
					if (deleting) {
						setConfirmingDelete(true);
						return;
					}
					apply.mutate({ insightId });
				}}
				size="sm"
				tone={deleting ? "destructive" : "neutral"}
				type="button"
				variant={deleting ? "ghost" : "secondary"}
			>
				{accessReason ? "Review access" : action}
			</Button>
			{accessReason ? (
				<p className="text-muted-foreground text-xs">{accessReason}</p>
			) : null}
			{deleting ? (
				<DeleteDialog
					confirmLabel={`Delete ${definitionType}`}
					description={`Delete ${entityLabel}? Historical events remain in your analytics, but this ${definitionType} will no longer be available for reporting.`}
					isDeleting={apply.isPending}
					isOpen={confirmingDelete}
					onClose={() => setConfirmingDelete(false)}
					onConfirm={async () => {
						await apply.mutateAsync({ insightId });
					}}
					title={`Delete ${definitionType}`}
				/>
			) : null}
		</div>
	);
}

export function FindingBody({
	evidenceOpen,
	outcome,
}: {
	evidenceOpen: boolean;
	outcome: InvestigationOutcome;
}) {
	return (
		<div className="space-y-4">
			<dl className="space-y-4">
				<div>
					<dt className="font-medium text-muted-foreground text-xs">
						What happened
					</dt>
					<dd className="mt-1 text-pretty text-foreground/85 text-sm leading-relaxed">
						{outcome.summary}
					</dd>
				</div>
				{outcome.rootCause ? (
					<div>
						<dt className="font-medium text-muted-foreground text-xs">Why</dt>
						<dd className="mt-1 text-pretty text-foreground/85 text-sm leading-relaxed">
							{outcome.rootCause}
						</dd>
					</div>
				) : null}
				{outcome.impact ? (
					<div>
						<dt className="font-medium text-muted-foreground text-xs">
							Why it matters
						</dt>
						<dd className="mt-1 text-pretty text-foreground/85 text-sm leading-relaxed">
							{outcome.impact}
						</dd>
					</div>
				) : null}
			</dl>
			{outcome.evidence.length > 0 ? (
				<Evidence evidence={outcome.evidence} initiallyOpen={evidenceOpen} />
			) : null}
			<ContextUsed snapshot={outcome.contextSnapshot} />
		</div>
	);
}

function Evidence({
	evidence,
	initiallyOpen,
}: {
	evidence: string[];
	initiallyOpen: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	const id = useId();
	return (
		<div>
			<Button
				aria-controls={id}
				aria-expanded={open}
				className="text-muted-foreground"
				onClick={() => setOpen((value) => !value)}
				size="sm"
				type="button"
				variant="ghost"
			>
				Evidence
				<span className="tabular-nums">({evidence.length})</span>
				<CaretDownIcon
					aria-hidden
					className={cn("size-3", open && "rotate-180")}
				/>
			</Button>
			{open ? (
				<ul className="mt-2 space-y-1.5" id={id}>
					{evidence.map((entry) => (
						<li
							className="flex gap-2 text-muted-foreground text-sm leading-relaxed"
							key={entry}
						>
							<span aria-hidden className="text-muted-foreground/50">
								•
							</span>
							<span>{entry}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function investigationSourceLink(
	item: Pick<InvestigationItem, "entity" | "period">,
	websiteId: string
): { href: string; label: string } | null {
	const base = `/websites/${encodeURIComponent(websiteId)}`;
	const params = new URLSearchParams({
		startDate: item.period.current.from,
		endDate: item.period.current.to,
	});
	switch (item.entity.type) {
		case "event":
			return {
				href: `${base}/events/${encodeURIComponent(item.entity.id)}?${params}`,
				label: "Open event",
			};
		case "funnel":
		case "funnel_step": {
			let funnelId: string | null = item.entity.id;
			if (item.entity.type === "funnel_step") {
				const separator = item.entity.id.lastIndexOf(":step:");
				const step = item.entity.id.slice(separator + 6);
				funnelId =
					separator > 0 &&
					Number.isSafeInteger(Number(step)) &&
					Number(step) >= 2 &&
					String(Number(step)) === step
						? item.entity.id.slice(0, separator)
						: null;
			}
			if (funnelId) {
				params.set("funnelId", funnelId);
			}
			return {
				href: `${base}/funnels?${params}${funnelId ? `#${encodeURIComponent(`funnel-${funnelId}`)}` : ""}`,
				label: "Open funnel",
			};
		}
		case "goal":
			params.set("goalId", item.entity.id);
			return {
				href: `${base}/goals?${params}#${encodeURIComponent(`goal-${item.entity.id}`)}`,
				label: "Open goal",
			};
		default:
			return null;
	}
}

export function formatPeriod(period: { from: string; to: string }): string {
	const from = dayjs.utc(period.from).format("MMM D");
	const to = dayjs.utc(period.to).format("MMM D");
	return from === to ? from : `${from}–${to}`;
}

export function nextCopy(
	next: InvestigationNext,
	options?: { verificationFailed?: boolean }
): { body: string; detail?: string; label: string } {
	switch (next.type) {
		case "act":
			return {
				body: next.action,
				detail: [`Checks: ${next.verification}`, scheduledRecheck(next)]
					.filter(Boolean)
					.join(" · "),
				label: "Suggested fix",
			};
		case "ask":
			return { body: next.question, label: "Question for you" };
		case "watch":
			return {
				body: next.escalation,
				detail: scheduledRecheck(next),
				label: options?.verificationFailed
					? "The fix did not hold"
					: "Watching",
			};
		case "resolve":
			return { body: next.reason, label: "Conclusion" };
		default:
			throw new Error("Unknown investigation outcome");
	}
}

function scheduledRecheck(
	next: Extract<InvestigationNext, { type: "act" | "watch" }>
): string | undefined {
	if (!next.recheckAt) {
		return;
	}
	return `Databuddy checks again ${dayjs.utc(next.recheckAt).format("MMM D")}`;
}
