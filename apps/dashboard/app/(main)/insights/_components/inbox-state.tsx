"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	InsightInboxNeed,
	InsightInboxState,
} from "@databuddy/shared/insights";
import { Button, dayjs } from "@databuddy/ui";
import {
	ChatTextIcon,
	CheckCircleIcon,
	ClockIcon,
	WarningCircleIcon,
	WrenchIcon,
} from "@databuddy/ui/icons";
import { toast } from "sonner";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { type InboxThread, insightQueries } from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import { showErrorToast } from "@/lib/user-facing-error";

export type InboxSection = InsightInboxState;

export const NEED_ORDER: InsightInboxNeed[] = [
	"look",
	"answer",
	"apply",
	"done",
];

export const NEED_CONFIG: Record<
	InsightInboxNeed,
	{ action: string; heading: string; icon: typeof ChatTextIcon; tone: string }
> = {
	answer: {
		action: "Answer",
		heading: "Answer a question",
		icon: ChatTextIcon,
		tone: "bg-primary/10 text-primary",
	},
	apply: {
		action: "Apply",
		heading: "Apply a fix",
		icon: WrenchIcon,
		tone: "bg-warning/10 text-warning",
	},
	done: {
		action: "Mark as done",
		heading: "Fix it yourself",
		icon: WrenchIcon,
		tone: "bg-warning/10 text-warning",
	},
	look: {
		action: "Look",
		heading: "A fix did not hold",
		icon: WarningCircleIcon,
		tone: "bg-destructive/10 text-destructive",
	},
};

export const SECTION_COPY: Record<
	InboxSection,
	{ description: string; title: string }
> = {
	needs_you: {
		description:
			"Questions to answer, fixes to apply or make, checks that failed, and suggestions to review.",
		title: "Needs you",
	},
	resolved: {
		description:
			"Findings that recovered, fixes that were verified, closed cases, and saved suggestions.",
		title: "Done",
	},
	watching: {
		description:
			"Fixes being verified, answers being investigated, and scheduled rechecks.",
		title: "Watching",
	},
};

export function sectionHref(section: InboxSection): string {
	switch (section) {
		case "needs_you":
			return "/insights";
		case "watching":
			return "/insights/watching";
		default:
			return "/insights/resolved";
	}
}

export function useInbox() {
	const { activeOrganization, activeOrganizationId } =
		useOrganizationsContext();
	const organizationId =
		activeOrganization?.id ?? activeOrganizationId ?? undefined;
	return useQuery(insightQueries.inbox(organizationId));
}

export function threadGlyph(thread: InboxThread): {
	icon: typeof ChatTextIcon;
	tone: string;
} {
	if (thread.need) {
		return NEED_CONFIG[thread.need];
	}
	if (thread.state === "resolved") {
		return { icon: CheckCircleIcon, tone: "bg-success/10 text-success" };
	}
	return { icon: ClockIcon, tone: "bg-muted text-muted-foreground" };
}

export function threadStatus(thread: InboxThread): string {
	if (thread.state === "resolved") {
		return thread.resolvedReason === "recovered"
			? "Recovered"
			: thread.next.verificationStatus === "passed"
				? "Verified"
				: "Closed";
	}
	if (thread.pendingReply?.status === "failed") {
		return "Verification could not start";
	}
	if (thread.pendingReply) {
		return thread.next.type === "ask"
			? "Investigating your answer"
			: "Verifying your fix";
	}
	if (thread.need === "look") {
		return "The fix did not hold";
	}
	if (thread.need) {
		return NEED_CONFIG[thread.need].heading;
	}
	if (thread.next.type === "ask") {
		return "Answered; picked up on the next run";
	}
	if (thread.next.recheckAt) {
		return `Checks again ${dayjs.utc(thread.next.recheckAt).format("MMM D")}`;
	}
	return "Waiting for the next check";
}

export function MarkDoneButton({
	insightId,
	label = "Mark as done",
}: {
	insightId: string;
	label?: string;
}) {
	const queryClient = useQueryClient();
	const markDone = useMutation({
		...orpc.insights.markDone.mutationOptions(),
		meta: { suppressGlobalErrorToast: true },
		onError: (error) => showErrorToast(error, "Could not mark this as done"),
		onSuccess: ({ reply }) => {
			queryClient
				.invalidateQueries({ queryKey: insightQueries.all() })
				.catch(() => undefined);
			toast.success(
				reply.status === "failed"
					? "Marked as done, but verification could not start"
					: "Marked as done. Databuddy will verify the result"
			);
		},
	});
	return (
		<Button
			loading={markDone.isPending}
			onClick={() => markDone.mutate({ insightId })}
			size="sm"
			type="button"
			variant="primary"
		>
			{label}
		</Button>
	);
}
